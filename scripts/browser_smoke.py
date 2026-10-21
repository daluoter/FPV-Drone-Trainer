#!/usr/bin/env python3
"""Exercise the production Pages build in a real, software-rendered Chromium."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
from urllib.error import URLError
from urllib.parse import urlsplit
from urllib.request import urlopen

from playwright.sync_api import expect, sync_playwright


PROJECT_ROOT = Path(__file__).resolve().parents[1]
BASE_PATH = "/FPV-Drone-Trainer/"


def wait_for_preview(process: subprocess.Popen, url: str) -> None:
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise RuntimeError("Vite preview exited before becoming ready; see preview.log.")
        try:
            with urlopen(url, timeout=1) as response:
                if response.status == 200:
                    return
        except (OSError, URLError):
            pass
        time.sleep(0.1)
    raise RuntimeError("Vite preview did not become ready; see preview.log.")


def stop_preview(process: subprocess.Popen) -> None:
    if process.poll() is None:
        os.killpg(process.pid, signal.SIGTERM)
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
            process.wait(timeout=5)


def training_progress(page) -> dict:
    return page.evaluate(
        """() => Object.fromEntries(
          Object.entries(localStorage)
            .filter(([key]) => key.startsWith('fpv-drone-trainer.training-progress.'))
            .sort(([left], [right]) => left.localeCompare(right))
        )"""
    )


def run_browser(url: str, artifact_dir: Path, executable: str | None, screenshot: bool) -> dict:
    errors: list[str] = []
    console_messages: list[dict] = []
    checks: list[str] = []
    report = {"base_path": BASE_PATH, "checks": checks, "errors": errors}

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(
            headless=True,
            executable_path=executable,
            args=[
                "--use-gl=angle",
                "--use-angle=swiftshader",
                "--enable-unsafe-swiftshader",
            ],
        )
        context = browser.new_context(viewport={"width": 1280, "height": 720})
        context.set_default_timeout(20_000)
        context.tracing.start(screenshots=True, snapshots=True, sources=True)
        page = context.new_page()
        report["chromium_version"] = browser.version

        def record_response(response) -> None:
            if response.request.resource_type in {"script", "stylesheet"} and response.status >= 400:
                errors.append(f"Asset HTTP {response.status}: {urlsplit(response.url).path}")

        def record_failure(request) -> None:
            if request.resource_type in {"script", "stylesheet"}:
                errors.append(f"Asset request failed: {urlsplit(request.url).path}")

        def record_console(message) -> None:
            console_messages.append({"type": message.type, "text": message.text})
            if message.type == "error":
                errors.append(f"Browser console error: {message.text}")

        page.on("pageerror", lambda error: errors.append(f"Uncaught page error: {error}"))
        page.on("response", record_response)
        page.on("requestfailed", record_failure)
        page.on("console", record_console)

        try:
            response = page.goto(url, wait_until="networkidle")
            if response is None or response.status != 200:
                raise AssertionError("The production entry page did not return HTTP 200.")
            expect(page).to_have_title("FPV Drone Trainer")

            asset_urls = page.locator("script[src], link[rel='stylesheet'][href]").evaluate_all(
                "elements => elements.map(element => element.src || element.href)"
            )
            expected_origin = urlsplit(url).netloc
            if not asset_urls:
                raise AssertionError("The production page has no JavaScript or CSS assets.")
            for asset_url in asset_urls:
                asset = urlsplit(asset_url)
                if asset.netloc != expected_origin or not asset.path.startswith(f"{BASE_PATH}assets/"):
                    raise AssertionError(f"Asset escaped the Pages project path: {asset.path}")
            checks.append("production entry and project-path assets")

            flight = page.locator("#free-flight")
            canvas = flight.locator("canvas")
            expect(canvas).to_be_visible()
            expect(flight.locator(".flight-rendering-error")).to_have_count(0)
            webgl = canvas.evaluate(
                """canvas => {
                  const gl = canvas.getContext('webgl2');
                  return gl && {
                    width: gl.drawingBufferWidth,
                    height: gl.drawingBufferHeight,
                    contextLost: gl.isContextLost(),
                  };
                }"""
            )
            if not webgl or webgl["contextLost"] or webgl["width"] <= 0 or webgl["height"] <= 0:
                raise AssertionError(f"No usable WebGL2 drawing buffer: {webgl}")
            report["webgl"] = webgl
            checks.append("initialized WebGL2 viewport")
            for control in (flight.locator('.flight-controls'), page.locator('#training').get_by_role('button', name='開始課程', exact=True)):
                bounds = control.bounding_box()
                if not bounds or bounds['y'] < 0 or bounds['y'] + bounds['height'] > 720:
                    raise AssertionError(f"Essential learning control is outside the 1280x720 viewport: {bounds}")
            checks.append("essential flight and lesson controls fit desktop viewport")


            page.locator("#flight-input-source").select_option("keyboard")
            arm = flight.get_by_role("button", name="Arm", exact=True)
            disarm = flight.get_by_role("button", name="Disarm", exact=True)
            arm.click()
            expect(disarm).to_be_enabled()
            expect(arm).to_be_disabled()
            expect(flight.locator(".flight-state-badge")).to_contain_text("ARMED / simulation running")
            disarm.click()
            expect(disarm).to_be_disabled()
            expect(arm).to_be_enabled()
            expect(flight.locator(".flight-state-badge")).to_contain_text("SAFE / disarmed")
            checks.append("explicit keyboard arm and disarm")

            lesson = page.locator("#school-lesson")
            training = page.locator("#training")
            phase = training.locator(".school-phase")
            source = page.locator("#flight-input-source")
            expect(lesson).to_have_value("takeoff")
            expect(lesson.locator("option:checked")).to_contain_text("L01")
            progress_before_waiting = training_progress(page)
            training.get_by_role("button", name="開始課程", exact=True).click()
            expect(phase).to_have_text("倒數準備")
            expect(arm).to_be_disabled()
            expect(source).to_be_disabled()
            expect(lesson).to_be_disabled()
            expect(phase).to_have_text("等待解鎖", timeout=10_000)
            expect(arm).to_be_enabled()
            page.wait_for_timeout(1_000)
            expect(phase).to_have_text("等待解鎖")
            expect(training.locator(".school-result")).to_have_count(0)
            expect(training.locator(".school-metrics")).to_have_count(0)
            if training_progress(page) != progress_before_waiting:
                raise AssertionError("Waiting for explicit arm wrote training progress.")
            page.keyboard.press("x")
            expect(phase).to_have_text("準備選課")
            expect(source).to_be_enabled()
            expect(lesson).to_be_enabled()
            expect(disarm).to_be_disabled()
            expect(training.locator(".school-result")).to_have_count(0)
            if training_progress(page) != progress_before_waiting:
                raise AssertionError("Keyboard reset while waiting wrote training progress.")
            training.get_by_role("button", name="開始課程", exact=True).click()
            expect(phase).to_have_text("等待解鎖", timeout=10_000)
            expect(arm).to_be_enabled()
            arm.click()
            expect(phase).to_have_text("練習進行中")
            expect(disarm).to_be_enabled()
            training.get_by_role("button", name="停止練習", exact=True).click()
            expect(phase).to_have_text("準備選課")
            expect(disarm).to_be_disabled()
            expect(source).to_be_enabled()
            checks.append("L01 countdown, untimed arm wait, keyboard reset and explicit training stop")

            progress_before_demo = training_progress(page)
            flight.get_by_role("button", name="L01 起飛示範", exact=True).click()
            expect(arm).to_be_disabled()
            expect(source).to_be_disabled()
            expect(lesson).to_be_disabled()
            expect(training.get_by_role("button", name="開始課程", exact=True)).to_be_disabled()
            cue = flight.locator(".school-demo-cue")
            demonstration_sticks = flight.get_by_role("region", name="Mode 2 demonstration stick overlay", exact=True)
            expect(cue).to_be_visible()
            expect(demonstration_sticks).to_be_visible()
            flight.get_by_role("button", name="Pause", exact=True).click()
            expect(flight.get_by_role("button", name="Play", exact=True)).to_be_enabled()
            timeline = flight.locator("#flight-replay-timeline")
            paused_at = float(timeline.input_value())
            page.wait_for_timeout(200)
            if abs(float(timeline.input_value()) - paused_at) > 0.02:
                raise AssertionError("The paused demonstration clock kept advancing.")

            timeline.press("End")
            expect(cue).to_contain_text("連續穩住")
            if abs(float(timeline.input_value()) - float(timeline.get_attribute("max"))) > 0.02:
                raise AssertionError("Seeking did not reach the end of the demonstration.")
            dots = demonstration_sticks.locator(".mode2-stick-dot").evaluate_all(
                "elements => elements.map(element => ({left: parseFloat(element.style.left), top: parseFloat(element.style.top)}))"
            )
            if len(dots) != 2 or not all(8 <= dot[axis] <= 92 for dot in dots for axis in ("left", "top")):
                raise AssertionError(f"Demonstration stick positions escaped normalized bounds: {dots}")
            if any(abs(value - 50) > 0.01 for value in (dots[0]["left"], dots[1]["left"], dots[1]["top"])):
                raise AssertionError("Takeoff demonstration sticks did not show centered roll, pitch and yaw.")
            if dots[0]["top"] >= 91:
                raise AssertionError("Demonstration sticks show live idle throttle rather than recorded takeoff input.")

            timeline.press("Home")
            expect(cue).to_contain_text("先確認機身水平")
            expect(timeline).to_have_value("0")
            half_speed = flight.get_by_role("button", name="0.5×", exact=True)
            half_speed.click()
            expect(half_speed).to_have_attribute("aria-pressed", "true")
            flight.get_by_role("button", name="Play", exact=True).click()
            page.wait_for_function(
                "Number(document.querySelector('#flight-replay-timeline')?.value) > 0.15"
            )
            flight.get_by_role("button", name="Pause", exact=True).click()
            expect(phase).to_have_text("準備選課")
            flight.get_by_role("button", name="Exit playback", exact=True).click()
            expect(disarm).to_be_disabled()
            expect(arm).to_be_enabled()
            expect(source).to_be_enabled()
            expect(flight.locator(".flight-state-badge")).to_contain_text("SAFE / disarmed")
            expect(flight.get_by_role("region", name="Mode 2 live stick overlay", exact=True)).to_be_visible()
            expect(training.locator(".school-result")).to_have_count(0)
            if training_progress(page) != progress_before_demo:
                raise AssertionError("Demonstration playback modified training progress.")
            checks.append("synchronized L01 demo pause, seek, speed, recorded sticks and progress isolation")

            for camera_name in ("Chase", "Free / debug", "FPV"):
                camera = flight.get_by_role("button", name=camera_name, exact=True)
                camera.click()
                expect(camera).to_have_attribute("aria-pressed", "true")
            checks.append("FPV, Chase and Free camera controls")

            logo = page.get_by_role("link", name="FPV Drone Trainer home", exact=True)
            expect(logo).to_have_attribute("href", BASE_PATH)
            logo.click()
            page.wait_for_load_state("networkidle")
            if urlsplit(page.url).path != BASE_PATH:
                raise AssertionError("The logo navigated outside the Pages project path.")
            expect(page.locator("#free-flight canvas")).to_be_visible()
            checks.append("logo reload preserves project path")

            if screenshot:
                page.evaluate("window.scrollTo({top: 0, behavior: 'instant'})")
                page.screenshot(path=str(artifact_dir / "workspace-1280x720.png"))

            if errors:
                raise AssertionError("Browser errors occurred: " + "; ".join(errors))
            report["status"] = "passed"
            context.tracing.stop()
            return report
        except Exception as error:
            report["status"] = "failed"
            report["failure"] = str(error)
            try:
                page.screenshot(path=str(artifact_dir / "failure.png"), full_page=True, timeout=5_000)
            except Exception as screenshot_error:
                report["screenshot_error"] = str(screenshot_error)
            context.tracing.stop(path=str(artifact_dir / "trace.zip"))
            raise
        finally:
            (artifact_dir / "report.json").write_text(json.dumps(report, indent=2) + "\n")
            (artifact_dir / "console.json").write_text(json.dumps(console_messages, indent=2) + "\n")
            context.close()
            browser.close()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=5180)
    parser.add_argument("--artifact-dir", type=Path, default=Path(tempfile.gettempdir()) / "fpv-browser-smoke")
    parser.add_argument("--chromium-executable", default=os.environ.get("PLAYWRIGHT_CHROMIUM_EXECUTABLE"))
    parser.add_argument("--screenshot", action="store_true", help="Save a successful 1280x720 workspace screenshot.")
    args = parser.parse_args()
    if not 0 < args.port < 65536:
        parser.error("--port must be between 1 and 65535")
    if not (PROJECT_ROOT / "dist" / "index.html").is_file():
        parser.error("Build the production site with --base=/FPV-Drone-Trainer/ before running this check.")

    args.artifact_dir.mkdir(parents=True, exist_ok=True)
    artifact_dir = Path(tempfile.mkdtemp(prefix="run-", dir=args.artifact_dir))
    url = f"http://127.0.0.1:{args.port}{BASE_PATH}"
    try:
        with (artifact_dir / "preview.log").open("w") as preview_log:
            preview = subprocess.Popen(
                [
                    "npm", "run", "preview", "--", f"--base={BASE_PATH}",
                    "--host", "127.0.0.1", "--port", str(args.port), "--strictPort",
                ],
                cwd=PROJECT_ROOT,
                stdout=preview_log,
                stderr=subprocess.STDOUT,
                start_new_session=True,
            )
            try:
                wait_for_preview(preview, url)
                report = run_browser(url, artifact_dir, args.chromium_executable, args.screenshot)
            finally:
                stop_preview(preview)
        print(f"Production browser smoke passed ({len(report['checks'])} checks).")
        print(f"Diagnostics: {artifact_dir}")
        return 0
    except Exception as error:
        (artifact_dir / "failure.txt").write_text(f"{type(error).__name__}: {error}\n")
        print(f"Production browser smoke failed: {error}", file=sys.stderr)
        print(f"Diagnostics: {artifact_dir}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
