#!/usr/bin/env python3
"""Exercise the production Pages build in a real, software-rendered Chromium."""

from __future__ import annotations

import argparse
import json
import os
import re
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
            mode = page.locator("#school-mode")
            expect(mode).to_have_value("practice")
            expect(lesson).to_have_value("takeoff")
            expect(lesson.locator("option:checked")).to_contain_text("L01")
            expect(lesson.locator("option")).to_have_count(7)
            expect(lesson.locator("option[value='landing']")).to_contain_text("L04")
            expect(lesson.locator("option[value='straight-line']")).to_contain_text("L03")
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
            flight.get_by_role("button", name="結束示範", exact=True).click()
            expect(disarm).to_be_disabled()
            expect(arm).to_be_enabled()
            expect(source).to_be_enabled()
            expect(flight.locator(".flight-state-badge")).to_contain_text("SAFE / disarmed")
            expect(flight.get_by_role("region", name="Mode 2 live stick overlay", exact=True)).to_be_visible()
            expect(training.locator(".school-result")).to_have_count(0)
            if training_progress(page) != progress_before_demo:
                raise AssertionError("Demonstration playback modified training progress.")
            checks.append("synchronized L01 demo pause, seek, speed, recorded sticks and progress isolation")

            # Produce a real interrupted attempt through the UI, then verify
            # practice/challenge summaries use their own persisted conditions.
            training.get_by_role("button", name="開始課程", exact=True).click()
            expect(phase).to_have_text("等待解鎖", timeout=10_000)
            arm.click()
            expect(phase).to_have_text("練習進行中")
            page.wait_for_timeout(200)
            disarm.click()
            expect(phase).to_have_text("練習結果")
            expect(training.locator(".school-result")).to_contain_text("引導練習")
            expect(training.locator(".school-progress")).to_contain_text("已練 1 次")
            stored_attempts = training_progress(page)
            # This marker must use the completed attempt's recording, stay
            # paused and leave both the live flight and persisted score alone.
            result_replay = flight.get_by_role("region", name="本次結果回放", exact=True)
            finish_marker = result_replay.get_by_role("button", name=re.compile(r"^回放：練習結束"))
            expect(finish_marker).to_be_enabled()
            finish_marker.click()
            expect(flight.get_by_role("button", name="Play", exact=True)).to_be_enabled()
            expect(disarm).to_be_disabled()
            expect(arm).to_be_disabled()
            marked_time = float(timeline.input_value())
            page.wait_for_timeout(200)
            if abs(float(timeline.input_value()) - marked_time) > .02:
                raise AssertionError("A result marker did not leave its replay paused.")
            if training_progress(page) != stored_attempts:
                raise AssertionError("Result marker playback modified training progress.")
            if screenshot:
                page.screenshot(path=str(artifact_dir / "result-marker-replay.png"))
            flight.get_by_role("button", name="結束回放", exact=True).click()
            expect(disarm).to_be_disabled()
            expect(arm).to_be_enabled()
            expect(phase).to_have_text("練習結果")
            checks.append("session-bound result marker seek, paused playback and progress isolation")
            contexts = [json.loads(document).get("context") for document in stored_attempts.values()]
            if len(contexts) != 1 or contexts[0]["mode"] != "practice" or contexts[0]["inputSource"] != "keyboard":
                raise AssertionError("The real interrupted attempt did not retain practice/keyboard provenance.")
            training.get_by_role("button", name="重設課程", exact=True).click()
            expect(phase).to_have_text("準備選課")
            mode.select_option("challenge")
            expect(training.locator(".school-progress")).to_contain_text("已練 0 次")
            mode.select_option("practice")
            expect(training.locator(".school-progress")).to_contain_text("已練 1 次")
            if training_progress(page) != stored_attempts:
                raise AssertionError("Changing learning mode modified stored flight results.")
            checks.append("default practice mode, seven lessons and persisted practice/challenge isolation")

            # Answer the actual radios/form. Wrong answers must not unlock the
            # next step; knowledge completion is separate from flight progress.
            page.locator("#school-open-intro").click()
            intro = page.locator(".intro-lesson")
            expect(intro).to_be_visible()
            next_intro = intro.get_by_role("button", name="下一步", exact=True)
            check_answer = intro.get_by_role("button", name="檢查答案", exact=True)
            expect(next_intro).to_be_disabled()
            expect(check_answer).to_be_disabled()
            # Exit where the user is answering, preserving the selection.
            intro.get_by_role("radio", name="偏航 Yaw：轉動機頭方向", exact=True).check()
            intro.get_by_role("button", name="看橫滾示意", exact=True).click()
            inline_exit = intro.get_by_role("button", name="結束示範，繼續作答", exact=True)
            expect(inline_exit).to_be_visible()
            expect(check_answer).to_be_disabled()
            if screenshot:
                page.screenshot(path=str(artifact_dir / "l00-inline-exit.png"))
            inline_exit.click()
            expect(check_answer).to_be_enabled()
            expect(intro.get_by_role("radio", name="偏航 Yaw：轉動機頭方向", exact=True)).to_be_checked()
            expect(disarm).to_be_disabled()
            checks.append("inline L00 demonstration exit restores answers without rearming")
            intro.get_by_role("radio", name="偏航 Yaw：轉動機頭方向", exact=True).check()
            check_answer.click()
            expect(intro.locator(".intro-lesson-feedback")).to_contain_text("再試一次")
            expect(next_intro).to_be_disabled()
            answers = (
                "橫滾 Roll：讓機身向左或右傾斜",
                "要求停止旋轉，但不會自動回平或煞停",
                "不一定，需觀察姿態與高度，再小量修正油門",
                "先確認狀態、低油門與中立，再明確按 Arm 解鎖",
            )
            for index, answer in enumerate(answers):
                intro.get_by_role("radio", name=answer, exact=True).check()
                check_answer.click()
                expect(intro.locator(".intro-lesson-feedback")).to_contain_text("答對了")
                if index < len(answers) - 1:
                    next_intro.click()
            intro.get_by_role("button", name="完成觀念練習", exact=True).click()
            expect(page.locator("#school-open-intro")).to_have_text("L00 觀念複習 ✓")
            expect(training).to_be_visible()
            if training_progress(page) != stored_attempts:
                raise AssertionError("Knowledge completion wrote a flight result.")
            page.reload(wait_until="networkidle")
            expect(page.locator("#school-open-intro")).to_have_text("L00 觀念複習 ✓")
            expect(mode).to_have_value("practice")
            source.select_option("keyboard")
            expect(training.locator(".school-progress")).to_contain_text("已練 1 次")
            checks.append("L00 wrong-answer gating, full knowledge completion and reload persistence")

            for demo_name, first_cue, final_cue in (
                ("L04 降落示範", "從地面起飛區開始", "平穩接地後"),
                ("L03 直線示範", "從地面起飛區開始", "在終點附近連續穩住"),
            ):
                before_demo = training_progress(page)
                flight.get_by_role("button", name=demo_name, exact=True).click()
                expect(arm).to_be_disabled()
                expect(source).to_be_disabled()
                expect(demonstration_sticks).to_be_visible()
                flight.get_by_role("button", name="Pause", exact=True).click()
                timeline.press("Home")
                expect(cue).to_contain_text(first_cue)
                expect(timeline).to_have_value("0")
                timeline.press("End")
                expect(cue).to_contain_text(final_cue)
                expect(flight.get_by_role("button", name="Play", exact=True)).to_be_enabled()
                expect(phase).to_have_text("準備選課")
                flight.get_by_role("button", name="結束示範", exact=True).click()
                expect(disarm).to_be_disabled()
                expect(arm).to_be_enabled()
                if training_progress(page) != before_demo:
                    raise AssertionError(f"{demo_name} modified flight progress.")
            checks.append("L03/L04 demonstration cue synchronization and progress isolation")

            # Both revised lessons wait on actual supported ground and remain
            # safe after arm at zero throttle while the learner prepares to lift off.
            hud = flight.get_by_role("checkbox", name="Developer HUD", exact=True)
            hud.check()
            position = flight.locator(".flight-data-row").filter(
                has=page.get_by_text("Position m", exact=True)
            ).locator("code")
            report["ground_start_positions"] = {}
            for lesson_id in ("landing", "straight-line"):
                lesson.select_option(lesson_id)
                training.get_by_role("button", name="開始課程", exact=True).click()
                coords = [float(value.strip()) for value in position.inner_text().split(",")]
                if len(coords) != 3 or abs(coords[0]) > .01 or abs(coords[2]) > .01 or not (0 < coords[1] < .15):
                    raise AssertionError(f"Lesson {lesson_id} did not start on supported ground: {coords}")
                expect(phase).to_have_text("等待解鎖", timeout=10_000)
                page.wait_for_timeout(500)
                coords = [float(value.strip()) for value in position.inner_text().split(",")]
                if len(coords) != 3 or abs(coords[0]) > .01 or abs(coords[2]) > .01 or not (0 < coords[1] < .15):
                    raise AssertionError(f"Lesson {lesson_id} did not start on supported ground: {coords}")
                expect(disarm).to_be_disabled()
                expect(training.locator(".school-result")).to_have_count(0)
                report["ground_start_positions"][lesson_id] = position.inner_text()
                if screenshot:
                    page.evaluate("window.scrollTo({top: 0, behavior: 'instant'})")
                    page.screenshot(path=str(artifact_dir / f"{lesson_id}-ground-start.png"))
                arm.click()
                expect(phase).to_have_text("練習進行中")
                page.wait_for_timeout(400)
                expect(phase).to_have_text("練習進行中")
                expect(flight.locator(".flight-state-badge")).not_to_contain_text("CRASHED")
                expect(training.locator(".school-objective")).to_be_visible()
                training.get_by_role("button", name="停止練習", exact=True).click()
                expect(phase).to_have_text("準備選課")
                expect(source).to_be_enabled()
            hud.uncheck()
            checks.append("L03/L04 actual ground start, safe low-throttle arm and visible stage guidance")

            fullscreen = flight.locator(".school-fullscreen")
            fullscreen.click()
            page.wait_for_function(
                "Boolean(document.fullscreenElement) || document.body.innerText.includes('瀏覽器未提供全螢幕')"
            )
            if page.evaluate("Boolean(document.fullscreenElement)"):
                expect(fullscreen).to_have_text("離開全螢幕")
                fullscreen.click()
                page.wait_for_function("!document.fullscreenElement")
                expect(fullscreen).to_have_text("全螢幕練習")
                report["fullscreen"] = "entered and exited"
            else:
                expect(flight.get_by_text("瀏覽器未提供全螢幕；仍可在目前畫面練習。", exact=True)).to_be_visible()
                report["fullscreen"] = "unsupported with actionable fallback"
            expect(disarm).to_be_disabled()
            expect(arm).to_be_enabled()
            checks.append("fullscreen entry/exit or graceful browser fallback")

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
