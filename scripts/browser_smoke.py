#!/usr/bin/env python3
"""Exercise the production Pages build in a real, software-rendered Chromium."""

from __future__ import annotations

import argparse
import json
import math
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
            expect(page.get_by_test_id("app-release")).to_have_text("版本 2026.10.30.2")
            report["release"] = page.get_by_test_id("app-release").inner_text()

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

            # A retired last-opened lesson must resume in the merged L01 while
            # preserving the saved knowledge/mode and original preference data.
            # Use an isolated context: no authored flight result is injected.
            legacy_context = browser.new_context(viewport={"width": 1280, "height": 720})
            legacy_context.set_default_timeout(20_000)
            try:
                legacy_page = legacy_context.new_page()
                legacy_page.on("pageerror", lambda error: errors.append(f"Legacy-selection page error: {error}"))
                legacy_page.on("response", record_response)
                legacy_page.on("requestfailed", record_failure)
                legacy_page.on("console", record_console)
                legacy_page.goto(url, wait_until="networkidle")
                legacy_preferences = json.dumps({
                    "schemaVersion": 1, "introCompleted": True,
                    "lastLessonId": "hover", "mode": "challenge",
                }, separators=(",", ":"))
                legacy_page.evaluate(
                    "raw => localStorage.setItem('fpv-drone-trainer.learning.v1', raw)",
                    legacy_preferences,
                )
                prior_legacy_progress = training_progress(legacy_page)
                legacy_page.reload(wait_until="networkidle")
                expect(legacy_page.locator("#school-lesson")).to_have_value("takeoff")
                expect(legacy_page.locator("#school-mode")).to_have_value("challenge")
                expect(legacy_page.locator("#school-open-intro")).to_have_text("L00 觀念複習 ✓")
                expect(legacy_page.locator("#training").get_by_role("heading", name="起飛與定點懸停", exact=True)).to_be_visible()
                if legacy_page.evaluate("localStorage.getItem('fpv-drone-trainer.learning.v1')") != legacy_preferences:
                    raise AssertionError("Redirecting the retired hover selection overwrote the original saved preferences.")
                if training_progress(legacy_page) != prior_legacy_progress:
                    raise AssertionError("Redirecting the retired hover selection modified training results.")
                report["legacy_hover_selection"] = {
                    "selected": "takeoff", "mode": "challenge", "intro_completed": True,
                    "original_preferences_preserved": True,
                }
                legacy_flip_preferences = json.dumps({
                    "schemaVersion": 1, "introCompleted": True,
                    "lastLessonId": "full-flip", "mode": "practice",
                }, separators=(",", ":"))
                legacy_page.evaluate(
                    "raw => localStorage.setItem('fpv-drone-trainer.learning.v1', raw)",
                    legacy_flip_preferences,
                )
                prior_legacy_progress = training_progress(legacy_page)
                legacy_page.reload(wait_until="networkidle")
                expect(legacy_page.locator("#school-lesson")).to_have_value("front-flip")
                expect(legacy_page.locator("#school-mode")).to_have_value("practice")
                expect(legacy_page.locator("#school-open-intro")).to_have_text("L00 觀念複習 ✓")
                legacy_training = legacy_page.locator("#training")
                expect(legacy_training.get_by_role("heading", name="前翻", exact=True)).to_be_visible()
                expect(legacy_training.locator(".school-checkpoints .is-complete")).to_have_count(0)
                expect(legacy_training.locator(".school-progress")).to_contain_text("已練 0 次")
                if legacy_page.evaluate("localStorage.getItem('fpv-drone-trainer.learning.v1')") != legacy_flip_preferences:
                    raise AssertionError("Redirecting the retired combined-flip selection overwrote the original saved preferences.")
                if training_progress(legacy_page) != prior_legacy_progress:
                    raise AssertionError("Redirecting the retired combined-flip selection modified training results.")
                report["legacy_full_flip_selection"] = {
                    "selected": "front-flip", "mode": "practice", "intro_completed": True,
                    "original_preferences_preserved": True, "new_completion_granted": False,
                }
            finally:
                legacy_context.close()
            checks.append("retired hover selection resumes merged L01 without rewriting preferences, knowledge or results")
            checks.append("retired combined-flip selection resumes L11 front flip without rewriting preferences or granting new completion")

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
            position_hud = flight.get_by_role("group", name="飛行位置", exact=True)
            altitude = flight.get_by_test_id("flight-altitude")
            expect(position_hud).to_be_visible()
            expect(altitude).to_have_text(re.compile(r"^-?\d+\.\d m$"))
            for coordinate in ("right", "up", "z"):
                expect(flight.get_by_test_id(f"flight-position-{coordinate}")).to_have_text(re.compile(r"^[+-]?\d+\.\d m$"))
            expect(position_hud).to_contain_text("相對起飛點")
            for axis in ("X", "Y", "Z"):
                expect(position_hud).to_contain_text(axis)
            checks.append("release identifier and always-visible altitude with explicit X/Y/Z without developer HUD")
            for control in (flight.locator('.flight-controls'), page.locator('#training').get_by_role('button', name='開始課程', exact=True)):
                bounds = control.bounding_box()
                if not bounds or bounds['y'] < 0 or bounds['y'] + bounds['height'] > 720:
                    raise AssertionError(f"Essential learning control is outside the 1280x720 viewport: {bounds}")
            toolbar_layout = flight.locator(".school-demo-toolbar").evaluate(
                "bar => ({viewportWidth: innerWidth, pageWidth: document.documentElement.scrollWidth, visibleWidth: bar.clientWidth, scrollWidth: bar.scrollWidth})"
            )
            if toolbar_layout["pageWidth"] > toolbar_layout["viewportWidth"] + 1:
                raise AssertionError(f"The demonstration toolbar causes body overflow: {toolbar_layout}")
            report["demonstration_toolbar_layout"] = toolbar_layout
            checks.append("essential flight and lesson controls fit desktop viewport without body overflow")


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
            demo_progress = page.get_by_role("region", name="示範進度", exact=True)
            report["demonstration_progress"] = {}

            def demonstration_snapshot(code: str, total: int, complete: bool = False) -> dict:
                expect(demo_progress).to_be_visible()
                expect(demo_progress).to_contain_text(code)
                expect(demo_progress).to_contain_text("觀看不計成績")
                steps = demo_progress.get_by_role("list", name="示範步驟", exact=True)
                expect(steps.get_by_role("listitem")).to_have_count(total)
                expect(page.get_by_role("list", name="本課步驟", exact=True)).to_have_count(0)
                if complete:
                    expect(demo_progress).to_contain_text(f"{total} / {total} 個示範步驟完成")
                    expect(steps.locator("[aria-current='step']")).to_have_count(0)
                else:
                    expect(demo_progress).not_to_contain_text(f"{total} / {total} 個示範步驟完成")
                    expect(steps.locator("[aria-current='step']")).to_have_count(1)
                count = re.search(r"(\d+) / (\d+) 個示範步驟完成", demo_progress.inner_text())
                if not count:
                    raise AssertionError(f"{code} has no independently readable demonstration step count.")
                snapshot = {
                    "completed": int(count.group(1)), "total": int(count.group(2)),
                    "current": steps.locator("[aria-current='step']").inner_text() if not complete else None,
                }
                report["demonstration_progress"].setdefault(code, []).append(snapshot)
                return snapshot
            expect(mode).to_have_value("practice")
            expect(lesson).to_have_value("takeoff")
            expect(lesson.locator("option:checked")).to_contain_text("L01")
            expect(lesson.locator("option")).to_have_count(18)
            expect(lesson.locator("option[value='hover']")).to_have_count(0)
            expect(lesson.locator("option[value='full-flip']")).to_have_count(0)
            active_codes = lesson.locator("option").evaluate_all(
                "options => options.map(option => option.textContent.trim().match(/^L\\d{2}/)?.[0])"
            )
            if active_codes != ["L01", "L02", "L03", "L04", "L05", "L06", "L07", "L08", "L09", "L10", "L11", "L12", "L13", "L14", "L15", "L16", "L17", "L19"]:
                raise AssertionError(f"Active course numbers do not match the merged curriculum: {active_codes}")
            report["active_course_codes"] = active_codes
            expect(training.get_by_role("heading", name="起飛與定點懸停", exact=True)).to_be_visible()
            expect(training.get_by_role("list", name="本課步驟", exact=True)).to_contain_text("懸停")
            expect(lesson.locator("option[value='landing']")).to_contain_text("L03")
            expect(lesson.locator("option[value='straight-line']")).to_contain_text("L02")
            expect(lesson.locator("option[value='direction-control']")).to_contain_text("L04")
            expect(lesson.locator("option[value='full-roll']")).to_contain_text("L10")
            expect(lesson.locator("option[value='front-flip']")).to_contain_text("L11")
            expect(lesson.locator("option[value='back-flip']")).to_contain_text("L12")
            expect(lesson.locator("option[value='power-loop']")).to_contain_text("L13")
            expect(lesson.locator("option[value='split-s']")).to_contain_text("L14")
            expect(lesson.locator("option[value='orbit']")).to_contain_text("L15")
            expect(lesson.locator("option[value='backward-flight']")).to_contain_text("L17")
            expect(lesson.locator("option[value='reverse-orbit']")).to_contain_text("L16")
            expect(lesson.locator("option[value='gravity-gate']")).to_contain_text("L19")
            for option in lesson.locator("option").all_text_contents():
                title = re.sub(r"^L\d{2}\s*[·：:]?\s*", "", option.strip())
                if title != "破S" and re.search(r"[A-Za-z]", title):
                    raise AssertionError(f"A visible course title still contains English: {option}")
            expect(flight.locator(".school-demo-toolbar").get_by_role("button")).to_have_count(21)
            expect(flight.get_by_role("button", name="L15 正刷鍋示範", exact=True)).to_be_visible()
            expect(flight.get_by_role("button", name="L16 倒刷鍋示範", exact=True)).to_be_visible()
            expect(flight.get_by_role("button", name="L17 後退飛行示範", exact=True)).to_be_visible()
            expect(flight.get_by_role("button", name="L19 重力門示範", exact=True)).to_be_visible()
            checks.append("Chinese course titles including 破S, eighteen active lessons and twenty-one distinct demonstrations in course order with L18 reserved")
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
            flight.get_by_role("button", name="L01 起飛與懸停示範", exact=True).click()
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
            demonstration_snapshot("L01", 3)
            paused_at = float(timeline.input_value())
            page.wait_for_timeout(200)
            if abs(float(timeline.input_value()) - paused_at) > 0.02:
                raise AssertionError("The paused demonstration clock kept advancing.")

            timeline.press("End")
            expect(cue).to_contain_text("懸停")
            demonstration_snapshot("L01", 3, complete=True)
            expect(demo_progress).to_contain_text("起飛與定點懸停")
            expect(demo_progress.get_by_role("list", name="示範步驟", exact=True).get_by_role("listitem").last).to_contain_text("懸停")
            expect(position_hud).to_contain_text("回放高度")
            end_altitude = float(altitude.inner_text().split()[0])
            if not 2.3 <= end_altitude <= 2.7:
                raise AssertionError(f"Replay HUD used live ground pose instead of takeoff ghost: {end_altitude}")
            paused_position = position_hud.inner_text()
            page.wait_for_timeout(200)
            if position_hud.inner_text() != paused_position:
                raise AssertionError("Paused replay position HUD kept changing.")
            if screenshot:
                flight.locator(".free-flight-viewport").screenshot(path=str(artifact_dir / "replay-position-hud.png"))
                page.locator(".free-flight-layout").evaluate("layout => window.scrollTo({top: layout.getBoundingClientRect().top + window.scrollY - 8, behavior: 'instant'})")
                page.screenshot(path=str(artifact_dir / "l01-takeoff-hover-demo.png"))
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
            demonstration_snapshot("L01", 3)
            expect(timeline).to_have_value("0")
            if float(altitude.inner_text().split()[0]) >= end_altitude - 1:
                raise AssertionError("Seeking the ghost did not update altitude HUD.")
            checks.append("replay altitude follows seek and freezes while paused")
            half_speed = flight.get_by_role("button", name="0.5×", exact=True)
            half_speed.click()
            expect(half_speed).to_have_attribute("aria-pressed", "true")
            flight.get_by_role("button", name="Play", exact=True).click()
            page.wait_for_function(
                "Number(document.querySelector('#flight-replay-timeline')?.value) > 0.15"
            )
            flight.get_by_role("button", name="Pause", exact=True).click()
            expect(phase).to_have_text("示範播放中")
            flight.get_by_role("button", name="結束示範", exact=True).click()
            expect(disarm).to_be_disabled()
            expect(arm).to_be_enabled()
            expect(source).to_be_enabled()
            expect(flight.locator(".flight-state-badge")).to_contain_text("SAFE / disarmed")
            expect(flight.get_by_role("region", name="Mode 2 live stick overlay", exact=True)).to_be_visible()
            expect(training.locator(".school-result")).to_have_count(0)
            expect(training.get_by_role("list", name="本課步驟", exact=True)).to_be_visible()
            expect(demo_progress).to_have_count(0)
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
            checks.append("default practice mode, eighteen active lessons and persisted practice/challenge isolation")

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
            flight.get_by_role("button", name="Pause", exact=True).click()
            timeline.press("Home")
            demonstration_snapshot("L00", 5)
            timeline.press("End")
            demonstration_snapshot("L00", 5, complete=True)
            timeline.press("Home")
            demonstration_snapshot("L00", 5)
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

            for axis_name in ("俯仰", "偏航"):
                before_axis_demo = training_progress(page)
                flight.get_by_role("button", name=axis_name, exact=True).click()
                flight.get_by_role("button", name="Pause", exact=True).click()
                timeline.press("Home")
                demonstration_snapshot("L00", 5)
                timeline.press("End")
                demonstration_snapshot("L00", 5, complete=True)
                timeline.press("Home")
                demonstration_snapshot("L00", 5)
                flight.get_by_role("button", name="結束示範", exact=True).click()
                expect(training.get_by_role("list", name="本課步驟", exact=True)).to_be_visible()
                if training_progress(page) != before_axis_demo:
                    raise AssertionError(f"{axis_name} demonstration modified flight progress.")

            lesson.select_option("landing")
            prior_landing_steps = training.get_by_role("list", name="本課步驟", exact=True).get_by_role("listitem").all_text_contents()
            for demo_name, first_cue, final_cue in (
                ("L03 降落示範", "從地面起飛區開始", "沒有墜毀就完成"),
                ("L02 直線示範", "從地面起飛區開始", "依序穿過藍、金、綠三圈就完成"),
            ):
                before_demo = training_progress(page)
                flight.get_by_role("button", name=demo_name, exact=True).click()
                expect(arm).to_be_disabled()
                expect(source).to_be_disabled()
                expect(demonstration_sticks).to_be_visible()
                flight.get_by_role("button", name="Pause", exact=True).click()
                timeline.press("Home")
                expect(cue).to_contain_text(first_cue)
                demonstration_snapshot(demo_name[:3], 5)
                expect(timeline).to_have_value("0")
                timeline.press("End")
                expect(cue).to_contain_text(final_cue)
                demonstration_snapshot(demo_name[:3], 5, complete=True)
                expect(flight.get_by_role("button", name="Play", exact=True)).to_be_enabled()
                expect(phase).to_have_text("示範播放中")
                timeline.press("Home")
                demonstration_snapshot(demo_name[:3], 5)
                flight.get_by_role("button", name="結束示範", exact=True).click()
                expect(disarm).to_be_disabled()
                expect(arm).to_be_enabled()
                expect(lesson).to_have_value("landing")
                expect(training.get_by_role("list", name="本課步驟", exact=True).get_by_role("listitem")).to_have_text(prior_landing_steps)
                expect(demo_progress).to_have_count(0)
                if training_progress(page) != before_demo:
                    raise AssertionError(f"{demo_name} modified flight progress.")
            checks.append("L02/L03 demonstration cue synchronization and progress isolation")

            lesson.select_option("direction-control")
            expect(training.locator(".school-route-guide")).to_contain_text("左右")
            before_direction_demo = training_progress(page)
            flight.get_by_role("button", name="L04 方向示範", exact=True).click()
            expect(arm).to_be_disabled()
            expect(lesson).to_be_disabled()
            flight.get_by_role("button", name="Pause", exact=True).click()
            timeline.press("Home")
            demonstration_snapshot("L04", 9)
            expect(cue).to_contain_text("從地面自行起飛")
            expect(altitude).to_have_text("0.0 m")
            timeline.press("End")
            demonstration_snapshot("L04", 9, complete=True)
            expect(cue).to_contain_text("已完成側移、前後移動與換向後方向感")
            expect(altitude).to_have_text("3.0 m")
            if float(flight.get_by_test_id("flight-position-z").inner_text().split()[0]) < 3:
                raise AssertionError("L04 ghost did not complete the body-right move after its heading change.")
            paused_direction_position = position_hud.inner_text()
            page.wait_for_timeout(200)
            if position_hud.inner_text() != paused_direction_position:
                raise AssertionError("L04 paused position kept advancing.")
            if screenshot:
                flight.locator(".free-flight-viewport").screenshot(path=str(artifact_dir / "l04-demonstration-fpv.png"))
                flight.get_by_role("button", name="Chase", exact=True).click()
                flight.locator(".free-flight-viewport").screenshot(path=str(artifact_dir / "l04-demonstration-chase.png"))
                flight.get_by_role("button", name="FPV", exact=True).click()
            timeline.press("Home")
            demonstration_snapshot("L04", 9)
            expect(altitude).to_have_text("0.0 m")
            flight.get_by_role("button", name="結束示範", exact=True).click()
            expect(disarm).to_be_disabled()
            expect(arm).to_be_enabled()
            if training_progress(page) != before_direction_demo:
                raise AssertionError("L04 demonstration wrote a flight result.")
            page.reload(wait_until="networkidle")
            expect(lesson).to_have_value("direction-control")
            expect(page.locator("#school-open-intro")).to_have_text("L00 觀念複習 ✓")
            source.select_option("keyboard")
            checks.append("L04 recorded direction demo, ghost seek and pause, progress isolation and lesson reload")

            lesson.select_option("coordinated-turn")
            expect(training.locator(".school-route-guide")).to_contain_text("右轉入口")
            expect(training.locator(".school-route-guide")).to_contain_text("左轉入口")
            before_turn_demo = training_progress(page)
            flight.get_by_role("button", name="L05 轉彎示範", exact=True).click()
            expect(arm).to_be_disabled()
            expect(lesson).to_be_disabled()
            flight.get_by_role("button", name="Pause", exact=True).click()
            timeline.press("Home")
            demonstration_snapshot("L05", 8)
            expect(cue).to_contain_text("地面")
            expect(altitude).to_have_text("0.0 m")
            timeline.press("End")
            demonstration_snapshot("L05", 8, complete=True)
            expect(cue).to_contain_text("已完成右轉與左轉協調航線")
            expect(altitude).to_have_text("3.0 m")
            if float(flight.get_by_test_id("flight-position-right").inner_text().split()[0]) < 14:
                raise AssertionError("L05 ghost did not reach the final left-turn exit X position.")
            if float(flight.get_by_test_id("flight-position-z").inner_text().split()[0]) > -16:
                raise AssertionError("L05 ghost did not reach the final left-turn exit Z position.")
            paused_turn_position = position_hud.inner_text()
            page.wait_for_timeout(200)
            if position_hud.inner_text() != paused_turn_position:
                raise AssertionError("L05 paused position kept advancing.")
            if screenshot:
                flight.locator(".free-flight-viewport").screenshot(path=str(artifact_dir / "l05-demonstration-fpv.png"))
                flight.get_by_role("button", name="Chase", exact=True).click()
                flight.locator(".free-flight-viewport").screenshot(path=str(artifact_dir / "l05-demonstration-chase.png"))
                flight.get_by_role("button", name="FPV", exact=True).click()
            timeline.press("Home")
            demonstration_snapshot("L05", 8)
            expect(altitude).to_have_text("0.0 m")
            flight.get_by_role("button", name="結束示範", exact=True).click()
            expect(disarm).to_be_disabled()
            expect(arm).to_be_enabled()
            if training_progress(page) != before_turn_demo:
                raise AssertionError("L05 demonstration wrote a flight result.")
            page.reload(wait_until="networkidle")
            expect(lesson).to_have_value("coordinated-turn")
            expect(page.locator("#school-open-intro")).to_have_text("L00 觀念複習 ✓")
            lesson.select_option("takeoff")
            source.select_option("keyboard")
            expect(training.locator(".school-progress")).to_contain_text("已練 1 次")
            lesson.select_option("coordinated-turn")
            expect(training.locator(".school-progress")).to_contain_text("已練 0 次")
            checks.append("L05 right/left recorded turn demo, native seek/pause, progress isolation and current-rule lesson reload")

            lesson.select_option("square-route")
            expect(training.get_by_role("heading", name="方形航線", exact=True)).to_be_visible()
            expect(training.locator(".school-route-guide")).to_contain_text("起飛")
            before_square_demo = training_progress(page)
            flight.get_by_role("button", name="L06 方形示範", exact=True).click()
            expect(arm).to_be_disabled()
            expect(lesson).to_be_disabled()
            flight.get_by_role("button", name="Pause", exact=True).click()
            timeline.press("Home")
            demonstration_snapshot("L06", 10)
            expect(cue).to_contain_text("地面")
            expect(altitude).to_have_text("0.0 m")
            timeline.press("End")
            demonstration_snapshot("L06", 10, complete=True)
            expect(cue).to_contain_text("已完成四段方形航線並回到起點上方")
            expect(altitude).to_have_text("3.0 m")
            for coordinate in ("right", "z"):
                if abs(float(flight.get_by_test_id(f"flight-position-{coordinate}").inner_text().split()[0])) > .6:
                    raise AssertionError("L06 ghost did not return above its supported launch point.")
            paused_square_position = position_hud.inner_text()
            page.wait_for_timeout(200)
            if position_hud.inner_text() != paused_square_position:
                raise AssertionError("L06 paused position kept advancing.")
            if screenshot:
                flight.locator(".free-flight-viewport").screenshot(path=str(artifact_dir / "l06-demonstration-fpv.png"))
                flight.get_by_role("button", name="Chase", exact=True).click()
                flight.locator(".free-flight-viewport").screenshot(path=str(artifact_dir / "l06-demonstration-chase.png"))
                flight.get_by_role("button", name="Free / debug", exact=True).click()
                flight.locator(".free-flight-viewport").screenshot(path=str(artifact_dir / "l06-demonstration-free.png"))
                flight.get_by_role("button", name="FPV", exact=True).click()
            timeline.press("Home")
            demonstration_snapshot("L06", 10)
            expect(altitude).to_have_text("0.0 m")
            flight.get_by_role("button", name="結束示範", exact=True).click()
            expect(disarm).to_be_disabled()
            expect(arm).to_be_enabled()
            if training_progress(page) != before_square_demo:
                raise AssertionError("L06 demonstration wrote a flight result.")
            page.reload(wait_until="networkidle")
            expect(lesson).to_have_value("square-route")
            expect(page.locator("#school-open-intro")).to_have_text("L00 觀念複習 ✓")
            source.select_option("keyboard")
            lesson.select_option("takeoff")
            expect(training.locator(".school-progress")).to_contain_text("已練 1 次")
            lesson.select_option("square-route")
            expect(training.locator(".school-progress")).to_contain_text("已練 0 次")
            checks.append("L06 four-leg square demo, native seek/pause, return-to-launch position, progress isolation and lesson reload")

            lesson.select_option("figure-eight")
            expect(training.get_by_role("heading", name="八字航線", exact=True)).to_be_visible()
            expect(training.locator(".school-route-guide")).to_contain_text("中央")
            before_eight_demo = training_progress(page)
            flight.get_by_role("button", name="L07 八字示範", exact=True).click()
            expect(arm).to_be_disabled()
            expect(lesson).to_be_disabled()
            flight.get_by_role("button", name="Pause", exact=True).click()
            timeline.press("Home")
            demonstration_snapshot("L07", 11)
            expect(cue).to_contain_text("地面")
            expect(altitude).to_have_text("0.0 m")
            timeline.press("End")
            demonstration_snapshot("L07", 11, complete=True)
            expect(cue).to_contain_text("已完成左右八字航線並回到中央終點")
            expect(altitude).to_have_text("3.0 m")
            if abs(float(flight.get_by_test_id("flight-position-right").inner_text().split()[0])) > .6:
                raise AssertionError("L07 ghost did not return to the central X position.")
            if abs(float(flight.get_by_test_id("flight-position-z").inner_text().split()[0]) + 6) > .6:
                raise AssertionError("L07 ghost did not return to the centre six metres ahead of launch.")
            paused_eight_position = position_hud.inner_text()
            page.wait_for_timeout(200)
            if position_hud.inner_text() != paused_eight_position:
                raise AssertionError("L07 paused position kept advancing.")
            if screenshot:
                flight.locator(".free-flight-viewport").screenshot(path=str(artifact_dir / "l07-demonstration-fpv.png"))
                flight.get_by_role("button", name="Chase", exact=True).click()
                flight.locator(".free-flight-viewport").screenshot(path=str(artifact_dir / "l07-demonstration-chase.png"))
                flight.get_by_role("button", name="Free / debug", exact=True).click()
                flight.locator(".free-flight-viewport").screenshot(path=str(artifact_dir / "l07-demonstration-free.png"))
                flight.get_by_role("button", name="FPV", exact=True).click()
            timeline.press("Home")
            demonstration_snapshot("L07", 11)
            expect(altitude).to_have_text("0.0 m")
            flight.get_by_role("button", name="結束示範", exact=True).click()
            expect(disarm).to_be_disabled()
            expect(arm).to_be_enabled()
            if training_progress(page) != before_eight_demo:
                raise AssertionError("L07 demonstration wrote a flight result.")
            page.reload(wait_until="networkidle")
            expect(lesson).to_have_value("figure-eight")
            expect(page.locator("#school-open-intro")).to_have_text("L00 觀念複習 ✓")
            source.select_option("keyboard")
            lesson.select_option("takeoff")
            expect(training.locator(".school-progress")).to_contain_text("已練 1 次")
            lesson.select_option("figure-eight")
            expect(training.locator(".school-progress")).to_contain_text("已練 0 次")
            checks.append("L07 left/right figure-eight demo, native seek/pause, central finish position, progress isolation and lesson reload")

            lesson.select_option("wide-gate")
            expect(training.get_by_role("heading", name="寬門穿越", exact=True)).to_be_visible()
            expect(training.locator(".school-route-guide")).to_contain_text("門")
            before_gate_demo = training_progress(page)
            flight.get_by_role("button", name="L08 穿門示範", exact=True).click()
            expect(arm).to_be_disabled()
            expect(lesson).to_be_disabled()
            flight.get_by_role("button", name="Pause", exact=True).click()
            timeline.press("Home")
            demonstration_snapshot("L08", 5)
            expect(cue).to_contain_text("地面")
            expect(altitude).to_have_text("0.0 m")
            if screenshot:
                flight.locator(".free-flight-viewport").screenshot(path=str(artifact_dir / "l08-demonstration-start.png"))
            timeline.press("End")
            demonstration_snapshot("L08", 5, complete=True)
            expect(cue).to_contain_text("已依序穿過三道寬門且未碰撞門框")
            expect(altitude).to_have_text("3.0 m")
            if abs(float(flight.get_by_test_id("flight-position-right").inner_text().split()[0])) > .6:
                raise AssertionError("L08 ghost did not remain near the gate centre line.")
            if float(flight.get_by_test_id("flight-position-z").inner_text().split()[0]) >= -24:
                raise AssertionError("L08 ghost did not pass beyond the third gate plane.")
            paused_gate_position = position_hud.inner_text()
            page.wait_for_timeout(200)
            if position_hud.inner_text() != paused_gate_position:
                raise AssertionError("L08 paused position kept advancing.")
            if screenshot:
                flight.locator(".free-flight-viewport").screenshot(path=str(artifact_dir / "l08-demonstration-fpv.png"))
                flight.get_by_role("button", name="Chase", exact=True).click()
                flight.locator(".free-flight-viewport").screenshot(path=str(artifact_dir / "l08-demonstration-chase.png"))
                flight.get_by_role("button", name="Free / debug", exact=True).click()
                flight.locator(".free-flight-viewport").screenshot(path=str(artifact_dir / "l08-demonstration-free.png"))
                flight.get_by_role("button", name="FPV", exact=True).click()
            timeline.press("Home")
            demonstration_snapshot("L08", 5)
            expect(altitude).to_have_text("0.0 m")
            flight.get_by_role("button", name="結束示範", exact=True).click()
            expect(disarm).to_be_disabled()
            expect(arm).to_be_enabled()
            if training_progress(page) != before_gate_demo:
                raise AssertionError("L08 demonstration wrote a flight result.")
            page.reload(wait_until="networkidle")
            expect(lesson).to_have_value("wide-gate")
            expect(page.locator("#school-open-intro")).to_have_text("L00 觀念複習 ✓")
            source.select_option("keyboard")
            lesson.select_option("takeoff")
            expect(training.locator(".school-progress")).to_contain_text("已練 1 次")
            lesson.select_option("wide-gate")
            expect(training.locator(".school-progress")).to_contain_text("已練 0 次")
            checks.append("L08 physical-frame demo, native seek/pause, beyond-third-gate finish, progress isolation and lesson reload")

            lesson.select_option("basic-recovery")
            expect(training.get_by_role("heading", name="基礎失誤恢復", exact=True)).to_be_visible()
            route = training.locator(".school-route-guide")
            for skill in ("傾斜", "下沉", "漂移"):
                expect(route).to_contain_text(skill)
            before_recovery_demo = training_progress(page)
            prior_recovery_steps = training.get_by_role("list", name="本課步驟", exact=True).get_by_role("listitem").all_text_contents()
            motion_hud = flight.get_by_role("group", name="恢復練習數值", exact=True)
            motion_fields = {
                "tilt_degrees": flight.get_by_test_id("recovery-tilt"),
                "vertical_mps": flight.get_by_test_id("recovery-vertical-speed"),
                "horizontal_mps": flight.get_by_test_id("recovery-horizontal-speed"),
            }

            def recovery_motion() -> dict:
                values = {}
                for key, field in motion_fields.items():
                    expect(field).to_be_visible()
                    match = re.match(r"^[+-]?\d+(?:\.\d+)?", field.inner_text())
                    if not match:
                        raise AssertionError(f"L09 motion readout is not numeric: {key}.")
                    values[key] = float(match.group())
                return values

            expect(motion_hud).to_be_visible()
            expect(flight.get_by_role("checkbox", name="Developer HUD", exact=True)).not_to_be_checked()
            prior_panel_scroll = training.evaluate("panel => { panel.scrollTop = panel.scrollHeight; return panel.scrollTop; }")
            if prior_panel_scroll <= 0:
                raise AssertionError("L09 sidebar scroll regression did not start from a scrolled course panel.")
            flight.get_by_role("button", name="L09 恢復示範", exact=True).click()
            page.wait_for_function("document.querySelector('#training').scrollTop === 0")
            heading_bounds = demo_progress.locator(".school-demonstration-heading").bounding_box()
            panel_bounds = training.bounding_box()
            if not heading_bounds or not panel_bounds or heading_bounds['y'] < panel_bounds['y']:
                raise AssertionError("The demonstration heading is hidden above its sidebar scrollport.")
            expect(flight.get_by_role("button", name="0.5×", exact=True)).to_have_attribute("aria-pressed", "true")
            expect(arm).to_be_disabled()
            expect(lesson).to_be_disabled()
            flight.get_by_role("button", name="Pause", exact=True).click()
            timeline.press("Home")
            demonstration_snapshot("L09", 8)
            expect(cue).to_contain_text("地面")
            expect(altitude).to_have_text("0.0 m")
            expect(motion_hud).to_contain_text("回放")
            home_motion = recovery_motion()
            if any(abs(value) > .05 for value in home_motion.values()):
                raise AssertionError(f"L09 demo did not start from a supported resting pose: {home_motion}")
            if screenshot:
                flight.locator(".free-flight-viewport").screenshot(path=str(artifact_dir / "l09-demonstration-start.png"))
            # Seek through the actual range control. The readouts must follow
            # the recorded ghost, including observable motion away from rest.
            recovery_samples = []
            for fraction in (.15, .35, .55, .75):
                bounds = timeline.bounding_box()
                if not bounds:
                    raise AssertionError("L09 replay timeline has no bounds.")
                timeline.click(position={"x": bounds["width"] * fraction, "y": bounds["height"] / 2})
                recovery_samples.append({"time_seconds": float(timeline.input_value()), **recovery_motion()})
            if not any(abs(sample[key]) > .05 for sample in recovery_samples for key in home_motion):
                raise AssertionError("L09 replay motion HUD did not change with the recorded ghost.")
            report["l09_motion_samples"] = recovery_samples
            timeline.press("End")
            demonstration_snapshot("L09", 8, complete=True)
            expect(cue).to_contain_text("已完成傾斜、下沉與漂移恢復")
            recovery_end_altitude = float(altitude.inner_text().split()[0])
            if not 3 <= recovery_end_altitude <= 5:
                raise AssertionError(f"L09 demo did not finish airborne near the practice height: {recovery_end_altitude}")
            paused_recovery_position = position_hud.inner_text()
            paused_recovery_motion = recovery_motion()
            page.wait_for_timeout(200)
            if position_hud.inner_text() != paused_recovery_position or recovery_motion() != paused_recovery_motion:
                raise AssertionError("L09 paused ghost position or motion readouts kept advancing.")
            if screenshot:
                flight.locator(".free-flight-viewport").screenshot(path=str(artifact_dir / "l09-demonstration-fpv.png"))
                flight.get_by_role("button", name="Chase", exact=True).click()
                flight.locator(".free-flight-viewport").screenshot(path=str(artifact_dir / "l09-demonstration-chase.png"))
                flight.get_by_role("button", name="Free / debug", exact=True).click()
                flight.locator(".free-flight-viewport").screenshot(path=str(artifact_dir / "l09-demonstration-free.png"))
                flight.get_by_role("button", name="FPV", exact=True).click()
            # The confusing steps 5–8 have their own chapter controls. Rewind
            # to a chapter, remain paused there, then continue the real ghost.
            for title, completed in (("產生小幅下沉", 4), ("建立前進或側移", 6)):
                demo_progress.get_by_role("button", name=f"觀看示範步驟：{title}", exact=True).click()
                expect(flight.get_by_role("button", name="Play", exact=True)).to_be_enabled()
                expect(demo_progress.get_by_role("list", name="示範步驟", exact=True).locator("[aria-current='step']")).to_contain_text(title)
                expect(demo_progress).to_contain_text(f"{completed} / 8 個示範步驟完成")
                chapter_time = float(timeline.input_value())
                page.wait_for_timeout(200)
                if abs(float(timeline.input_value()) - chapter_time) > .02:
                    raise AssertionError("L09 chapter seek did not leave the demonstration paused.")
                if screenshot:
                    page.locator(".free-flight-layout").evaluate("layout => window.scrollTo({top: layout.getBoundingClientRect().top + window.scrollY - 8, behavior: 'instant'})")
                    page.screenshot(path=str(artifact_dir / f"l09-demo-step-{completed + 1}.png"))
            if screenshot:
                page.set_viewport_size({"width": 375, "height": 720})
                demo_progress.scroll_into_view_if_needed()
                page.screenshot(path=str(artifact_dir / "l09-demo-progress-375.png"), full_page=True)
                page.set_viewport_size({"width": 1280, "height": 720})
            timeline.press("End")
            demonstration_snapshot("L09", 8, complete=True)
            timeline.press("Home")
            demonstration_snapshot("L09", 8)
            expect(altitude).to_have_text("0.0 m")
            if recovery_motion() != home_motion:
                raise AssertionError("L09 Home seek did not restore the recorded initial motion.")
            flight.get_by_role("button", name="結束示範", exact=True).click()
            expect(disarm).to_be_disabled()
            expect(arm).to_be_enabled()
            expect(motion_hud).not_to_contain_text("回放")
            expect(training.get_by_role("list", name="本課步驟", exact=True).get_by_role("listitem")).to_have_text(prior_recovery_steps)
            expect(demo_progress).to_have_count(0)
            restored_panel_scroll = training.evaluate("panel => panel.scrollTop")
            if abs(restored_panel_scroll - prior_panel_scroll) > 1:
                raise AssertionError("Exiting a demonstration did not restore the learner's sidebar reading position.")
            report["demonstration_sidebar_scroll"] = {"before": prior_panel_scroll, "during": 0, "after": restored_panel_scroll}
            if training_progress(page) != before_recovery_demo:
                raise AssertionError("L09 demonstration wrote a flight result.")
            page.reload(wait_until="networkidle")
            expect(lesson).to_have_value("basic-recovery")
            expect(page.locator("#school-open-intro")).to_have_text("L00 觀念複習 ✓")
            source.select_option("keyboard")
            lesson.select_option("takeoff")
            expect(training.locator(".school-progress")).to_contain_text("已練 1 次")
            lesson.select_option("basic-recovery")
            expect(training.locator(".school-progress")).to_contain_text("已練 0 次")
            checks.append("L09 eased recovery demo, half-speed, independent chapter5/7 seek/pause, ghost motion HUD, progress isolation and lesson reload")
            checks.append("all available demonstrations have independent seekable progress, including L00 actions and cross-lesson playback without overwriting live checkpoints")
            checks.append("scrolled course sidebar reveals demonstration progress at start and restores learner reading position on exit")

            lesson.select_option("full-roll")
            expect(training.get_by_role("heading", name=re.compile("橫滾"))).to_be_visible()
            before_roll_demo = training_progress(page)
            prior_roll_steps = training.get_by_role("list", name="本課步驟", exact=True).get_by_role("listitem").all_text_contents()
            if len(prior_roll_steps) != 6:
                raise AssertionError("L10 does not expose its six ordered ground-to-recovery checkpoints.")
            roll_hud = flight.get_by_role("group", name="橫滾練習數值", exact=True)
            roll_fields = {
                "progress_degrees": flight.get_by_test_id("roll-progress"),
                "roll_rate_dps": flight.get_by_test_id("roll-rate"),
                "tilt_degrees": flight.get_by_test_id("roll-tilt"),
            }

            def roll_motion() -> dict:
                values = {}
                for key, field in roll_fields.items():
                    expect(field).to_be_visible()
                    match = re.match(r"^[+-]?\d+(?:\.\d+)?", field.inner_text())
                    if not match:
                        raise AssertionError(f"L10 roll readout is not numeric: {key}.")
                    values[key] = float(match.group())
                return values

            expect(roll_hud).to_be_visible()
            flight.get_by_role("button", name="L10 橫滾示範", exact=True).click()
            expect(flight.get_by_role("button", name="0.5×", exact=True)).to_have_attribute("aria-pressed", "true")
            expect(arm).to_be_disabled()
            expect(lesson).to_be_disabled()
            expect(roll_hud).to_contain_text("回放")
            flight.get_by_role("button", name="Pause", exact=True).click()
            timeline.press("Home")
            demonstration_snapshot("L10", 6)
            expect(altitude).to_have_text("0.0 m")
            home_roll_motion = roll_motion()
            if any(abs(value) > .05 for value in home_roll_motion.values()):
                raise AssertionError(f"L10 demo did not start at a supported resting pose: {home_roll_motion}")
            if screenshot:
                flight.locator(".free-flight-viewport").screenshot(path=str(artifact_dir / "l10-demonstration-ground.png"))
            timeline.press("End")
            demonstration_snapshot("L10", 6, complete=True)
            end_roll_motion = roll_motion()
            if not 340 <= end_roll_motion["progress_degrees"] <= 360.1:
                raise AssertionError(f"L10 replay did not display a measured full turn: {end_roll_motion}")
            if end_roll_motion["tilt_degrees"] > 25.1 or abs(end_roll_motion["roll_rate_dps"]) > 90.1:
                raise AssertionError(f"L10 replay did not finish with a recovered actual ghost: {end_roll_motion}")
            if float(altitude.inner_text().split()[0]) < 1.5:
                raise AssertionError("L10 replay completed by stopping on the ground rather than recovering airborne.")
            paused_roll_position = position_hud.inner_text()
            page.wait_for_timeout(200)
            if position_hud.inner_text() != paused_roll_position or roll_motion() != end_roll_motion:
                raise AssertionError("L10 paused ghost position or roll instruments kept advancing.")
            report["l10_full_roll"] = {"home": home_roll_motion, "end": end_roll_motion}
            if screenshot:
                flight.locator(".free-flight-viewport").screenshot(path=str(artifact_dir / "l10-demonstration-fpv.png"))
                flight.get_by_role("button", name="Chase", exact=True).click()
                flight.locator(".free-flight-viewport").screenshot(path=str(artifact_dir / "l10-demonstration-chase.png"))
                flight.get_by_role("button", name="FPV", exact=True).click()
            # The fifth chapter begins when the retained physical state has
            # actually passed the inverted checkpoint; it is not an authored
            # future caption or an injected pose.
            roll_chapters = demo_progress.get_by_role("list", name="示範步驟", exact=True).get_by_role("button")
            roll_chapters.nth(4).click()
            expect(flight.get_by_role("button", name="Play", exact=True)).to_be_enabled()
            expect(demo_progress).to_contain_text("4 / 6 個示範步驟完成")
            inverted_motion = roll_motion()
            if inverted_motion["tilt_degrees"] <= 120:
                raise AssertionError(f"L10 inverted chapter used live/level telemetry instead of the recorded ghost: {inverted_motion}")
            chapter_time = float(timeline.input_value())
            page.wait_for_timeout(200)
            if abs(float(timeline.input_value()) - chapter_time) > .02 or roll_motion() != inverted_motion:
                raise AssertionError("L10 chapter selection did not leave the ghost and measured values paused.")
            report["l10_full_roll"]["inverted"] = {"time_seconds": chapter_time, **inverted_motion}
            if screenshot:
                page.locator(".free-flight-layout").evaluate("layout => window.scrollTo({top: layout.getBoundingClientRect().top + window.scrollY - 8, behavior: 'instant'})")
                page.screenshot(path=str(artifact_dir / "l10-demonstration-inverted.png"))

            report["l10_roll_hud_layouts"] = {}
            for width, height in ((1280, 720), (1280, 600), (375, 720)):
                page.set_viewport_size({"width": width, "height": height})
                position_hud.scroll_into_view_if_needed()
                viewport_bounds = flight.locator(".free-flight-viewport").bounding_box()
                roll_bounds = roll_hud.bounding_box()
                other_bounds = ((position_hud.bounding_box(), "position HUD"), (flight.locator(".flight-safe-overlay").bounding_box(), "playback banner"))
                if not viewport_bounds or not roll_bounds:
                    raise AssertionError(f"L10 roll instruments have no layout bounds at {width}x{height}.")
                if (roll_bounds['x'] < viewport_bounds['x']
                        or roll_bounds['x'] + roll_bounds['width'] > viewport_bounds['x'] + viewport_bounds['width']
                        or roll_bounds['y'] < viewport_bounds['y']
                        or roll_bounds['y'] + roll_bounds['height'] > viewport_bounds['y'] + viewport_bounds['height']):
                    raise AssertionError(f"L10 roll instruments overflow the viewport at {width}x{height}.")
                for other, label in other_bounds:
                    if not other:
                        raise AssertionError(f"L10 {label} has no layout bounds at {width}x{height}.")
                    overlap_x = min(roll_bounds['x'] + roll_bounds['width'], other['x'] + other['width']) - max(roll_bounds['x'], other['x'])
                    overlap_y = min(roll_bounds['y'] + roll_bounds['height'], other['y'] + other['height']) - max(roll_bounds['y'], other['y'])
                    if overlap_x > 0 and overlap_y > 0:
                        raise AssertionError(f"L10 roll instruments overlap {label} at {width}x{height}.")
                report["l10_roll_hud_layouts"][f"{width}x{height}"] = {"roll_hud": roll_bounds, "viewport": viewport_bounds}
                if screenshot and width == 375:
                    flight.locator(".free-flight-viewport").screenshot(path=str(artifact_dir / "l10-roll-hud-375.png"))
            page.set_viewport_size({"width": 1280, "height": 720})
            checks.append("L10 measured roll HUD follows the inverted ghost and fits desktop, short desktop and mobile without overlap")
            # Rewind farther to the roll-preparation chapter, then all the way
            # home, to verify that late completion never sticks in demo progress.
            roll_chapters.nth(3).click()
            expect(demo_progress).to_contain_text("3 / 6 個示範步驟完成")
            timeline.press("Home")
            demonstration_snapshot("L10", 6)
            if roll_motion() != home_roll_motion:
                raise AssertionError("L10 rewind did not restore its initial measured state.")
            timeline.press("End")
            demonstration_snapshot("L10", 6, complete=True)
            flight.get_by_role("button", name="結束示範", exact=True).click()
            expect(roll_hud).not_to_contain_text("回放")
            expect(arm).to_be_enabled()
            expect(disarm).to_be_disabled()
            expect(training.get_by_role("list", name="本課步驟", exact=True).get_by_role("listitem")).to_have_text(prior_roll_steps)
            expect(demo_progress).to_have_count(0)
            if training_progress(page) != before_roll_demo:
                raise AssertionError("L10 teaching playback changed a live result or another course's saved progress.")
            page.reload(wait_until="networkidle")
            expect(lesson).to_have_value("full-roll")
            expect(page.locator("#school-open-intro")).to_have_text("L00 觀念複習 ✓")
            source.select_option("keyboard")
            expect(training.locator(".school-progress")).to_contain_text("已練 0 次")
            lesson.select_option("takeoff")
            expect(training.locator(".school-progress")).to_contain_text("已練 1 次")
            lesson.select_option("full-roll")
            checks.append("L10 ground-start full-roll demo, measured inverted and upright phases, half-speed, chapter rewind, live-progress isolation and lesson reload")

            lesson.select_option("front-flip")
            expect(training.get_by_role("heading", name="前翻", exact=True)).to_be_visible()
            before_flip_demos = training_progress(page)
            prior_flip_steps = training.get_by_role("list", name="本課步驟", exact=True).get_by_role("listitem").all_text_contents()
            if len(prior_flip_steps) != 6:
                raise AssertionError("The directional flip course does not expose six ordered ground-to-recovery checkpoints.")
            flip_hud = flight.get_by_role("group", name="翻轉練習數值", exact=True)
            flip_fields = {
                "progress_degrees": flight.get_by_test_id("flip-progress"),
                "flip_rate_dps": flight.get_by_test_id("flip-rate"),
                "tilt_degrees": flight.get_by_test_id("flip-tilt"),
            }

            def flip_motion() -> dict:
                values = {}
                for key, field in flip_fields.items():
                    expect(field).to_be_visible()
                    match = re.match(r"^[+-]?\d+(?:\.\d+)?", field.inner_text())
                    if not match:
                        raise AssertionError(f"Directional flip readout is not numeric: {key}.")
                    values[key] = float(match.group())
                return values

            expect(flip_hud).to_be_visible()
            report["directional_flip_courses"] = {}
            report["directional_flip_hud_layouts"] = {}
            for direction, lesson_id, lesson_title, code, demo_name, rate_sign in (
                ("forward", "front-flip", "前翻", "L11", "L11 前翻示範", 1),
                ("backward", "back-flip", "後翻", "L12", "L12 後翻示範", -1),
            ):
                lesson.select_option(lesson_id)
                original_flip_canvas = canvas.element_handle()
                expect(training.get_by_role("heading", name=lesson_title, exact=True)).to_be_visible()
                expect(training.locator(".school-progress")).to_contain_text("已練 0 次")
                prior_flip_steps = training.get_by_role("list", name="本課步驟", exact=True).get_by_role("listitem").all_text_contents()
                if len(prior_flip_steps) != 6:
                    raise AssertionError(f"{code} does not expose six directional checkpoints.")
                flight.get_by_role("button", name=demo_name, exact=True).click()
                expect(flight.get_by_role("button", name="0.5×", exact=True)).to_have_attribute("aria-pressed", "true")
                expect(arm).to_be_disabled()
                expect(lesson).to_be_disabled()
                expect(flip_hud).to_contain_text("回放")
                flight.get_by_role("button", name="Pause", exact=True).click()
                timeline.press("Home")
                demonstration_snapshot(code, 6)
                expect(altitude).to_have_text("0.0 m")
                home_flip = flip_motion()
                if any(abs(value) > .05 for value in home_flip.values()):
                    raise AssertionError(f"{demo_name} does not begin from supported rest: {home_flip}")
                timeline.press("End")
                demonstration_snapshot(code, 6, complete=True)
                end_flip = flip_motion()
                if not 340 <= end_flip["progress_degrees"] <= 360.1:
                    raise AssertionError(f"{demo_name} does not display a measured full flip: {end_flip}")
                if end_flip["tilt_degrees"] > 30.1 or abs(end_flip["flip_rate_dps"]) > 120.1:
                    raise AssertionError(f"{demo_name} does not finish with a recovered actual ghost: {end_flip}")
                if float(altitude.inner_text().split()[0]) < 1.5:
                    raise AssertionError(f"{demo_name} completes on the ground rather than airborne.")
                paused_flip_position = position_hud.inner_text()
                page.wait_for_timeout(200)
                if position_hud.inner_text() != paused_flip_position or flip_motion() != end_flip:
                    raise AssertionError(f"{demo_name} paused position or flip instruments kept advancing.")
                if screenshot:
                    flight.locator(".free-flight-viewport").screenshot(path=str(artifact_dir / f"{code.lower()}-{direction}-demonstration-end.png"))
                flip_chapters = demo_progress.get_by_role("list", name="示範步驟", exact=True).get_by_role("button")
                flip_chapters.nth(4).click()
                expect(flight.get_by_role("button", name="Play", exact=True)).to_be_enabled()
                expect(demo_progress).to_contain_text("4 / 6 個示範步驟完成")
                inverted_flip = flip_motion()
                if inverted_flip["tilt_degrees"] <= 120:
                    raise AssertionError(f"{demo_name} inverted chapter shows a level/live pose: {inverted_flip}")
                if inverted_flip["flip_rate_dps"] * rate_sign < 5:
                    raise AssertionError(f"{demo_name} has the wrong actual forward/backward pitch direction: {inverted_flip}")
                if not 120 <= inverted_flip["progress_degrees"] <= 250:
                    raise AssertionError(f"{demo_name} inverted chapter lost its measured partial-turn progress: {inverted_flip}")
                chapter_time = float(timeline.input_value())
                page.wait_for_timeout(200)
                if abs(float(timeline.input_value()) - chapter_time) > .02 or flip_motion() != inverted_flip:
                    raise AssertionError(f"{demo_name} chapter selection did not pause the actual ghost and values.")
                report["directional_flip_courses"][direction] = {
                    "lesson_id": lesson_id, "course_code": code, "demonstration": demo_name,
                    "home": home_flip, "end": end_flip,
                    "inverted": {"time_seconds": chapter_time, **inverted_flip},
                }
                if screenshot:
                    page.locator(".free-flight-layout").evaluate("layout => window.scrollTo({top: layout.getBoundingClientRect().top + window.scrollY - 8, behavior: 'instant'})")
                    page.screenshot(path=str(artifact_dir / f"{code.lower()}-{direction}-demonstration-inverted.png"))
                report["directional_flip_hud_layouts"][direction] = {}
                for width, height in ((1280, 720), (1280, 600), (375, 720)):
                    page.set_viewport_size({"width": width, "height": height})
                    position_hud.scroll_into_view_if_needed()
                    viewport_bounds = flight.locator(".free-flight-viewport").bounding_box()
                    flip_bounds = flip_hud.bounding_box()
                    if not viewport_bounds or not flip_bounds:
                        raise AssertionError(f"{demo_name} instruments have no layout bounds at {width}x{height}.")
                    if (flip_bounds['x'] < viewport_bounds['x']
                            or flip_bounds['x'] + flip_bounds['width'] > viewport_bounds['x'] + viewport_bounds['width']
                            or flip_bounds['y'] < viewport_bounds['y']
                            or flip_bounds['y'] + flip_bounds['height'] > viewport_bounds['y'] + viewport_bounds['height']):
                        raise AssertionError(f"{demo_name} instruments overflow the viewport at {width}x{height}.")
                    for other, label in ((position_hud.bounding_box(), "position HUD"), (flight.locator(".flight-safe-overlay").bounding_box(), "playback banner")):
                        if not other:
                            raise AssertionError(f"{demo_name} {label} has no bounds at {width}x{height}.")
                        overlap_x = min(flip_bounds['x'] + flip_bounds['width'], other['x'] + other['width']) - max(flip_bounds['x'], other['x'])
                        overlap_y = min(flip_bounds['y'] + flip_bounds['height'], other['y'] + other['height']) - max(flip_bounds['y'], other['y'])
                        if overlap_x > 0 and overlap_y > 0:
                            raise AssertionError(f"{demo_name} instruments overlap {label} at {width}x{height}.")
                    report["directional_flip_hud_layouts"][direction][f"{width}x{height}"] = {"flip_hud": flip_bounds, "viewport": viewport_bounds}
                    if screenshot and width == 375:
                        flight.locator(".free-flight-viewport").screenshot(path=str(artifact_dir / f"{code.lower()}-{direction}-hud-375.png"))
                page.set_viewport_size({"width": 1280, "height": 720})
                flip_chapters.nth(3).click()
                expect(demo_progress).to_contain_text("3 / 6 個示範步驟完成")
                timeline.press("Home")
                demonstration_snapshot(code, 6)
                expect(altitude).to_have_text("0.0 m")
                if flip_motion() != home_flip:
                    raise AssertionError(f"{demo_name} Home seek does not restore its initial measured values.")
                timeline.press("End")
                demonstration_snapshot(code, 6, complete=True)
                flight.get_by_role("button", name="結束示範", exact=True).click()
                expect(arm).to_be_enabled()
                expect(disarm).to_be_disabled()
                expect(flip_hud).not_to_contain_text("回放")
                expect(demo_progress).to_have_count(0)
                expect(training.get_by_role("list", name="本課步驟", exact=True).get_by_role("listitem")).to_have_text(prior_flip_steps)
                if not original_flip_canvas or not original_flip_canvas.evaluate("element => element === document.querySelector('#free-flight canvas')"):
                    raise AssertionError(f"{demo_name} replaced the shared live flight canvas.")
                if training_progress(page) != before_flip_demos:
                    raise AssertionError(f"{demo_name} modified the live attempt or any saved result.")
                expect(lesson).to_have_value(lesson_id)
                other_name = "L12 後翻示範" if lesson_id == "front-flip" else "L11 前翻示範"
                other_code = "L12" if lesson_id == "front-flip" else "L11"
                flight.get_by_role("button", name=other_name, exact=True).click()
                flight.get_by_role("button", name="Pause", exact=True).click()
                timeline.press("End")
                demonstration_snapshot(other_code, 6, complete=True)
                expect(lesson).to_have_value(lesson_id)
                flight.get_by_role("button", name="結束示範", exact=True).click()
                expect(training.get_by_role("list", name="本課步驟", exact=True).get_by_role("listitem")).to_have_text(prior_flip_steps)
                expect(lesson).to_have_value(lesson_id)
                if training_progress(page) != before_flip_demos:
                    raise AssertionError(f"Watching {other_name} from {code} changed a directional result.")
                page.reload(wait_until="networkidle")
                expect(lesson).to_have_value(lesson_id)
                source.select_option("keyboard")
                expect(training.locator(".school-progress")).to_contain_text("已練 0 次")
            checks.append("L11 front and L12 back physical flip demos, signed inverted motion, full-turn recovery, independent seek/pause and live-result isolation")
            checks.append("both directional flip HUDs fit desktop, short desktop and mobile without overlapping altitude/XYZ or playback banner")
            checks.append("cross-course flip playback preserves each selected lesson and its live checkpoints without saving either completion")

            # The introductory pitch illustration remains a separate five-step
            # lesson even while the actual directional flip course is selected.
            flight.get_by_role("button", name="俯仰", exact=True).click()
            flight.get_by_role("button", name="Pause", exact=True).click()
            timeline.press("Home")
            demonstration_snapshot("L00", 5)
            expect(flip_hud).to_have_count(0)
            timeline.press("End")
            demonstration_snapshot("L00", 5, complete=True)
            flight.get_by_role("button", name="結束示範", exact=True).click()
            expect(flip_hud).to_be_visible()
            expect(training.get_by_role("list", name="本課步驟", exact=True).get_by_role("listitem")).to_have_text(prior_flip_steps)
            if training_progress(page) != before_flip_demos:
                raise AssertionError("L00 pitch playback while selecting L12 wrote a directional flip result.")
            page.reload(wait_until="networkidle")
            expect(lesson).to_have_value("back-flip")
            source.select_option("keyboard")
            expect(training.locator(".school-progress")).to_contain_text("已練 0 次")
            lesson.select_option("takeoff")
            expect(training.locator(".school-progress")).to_contain_text("已練 1 次")
            lesson.select_option("back-flip")
            checks.append("L00 pitch illustration stays separate from L11/L12 and directional demos preserve old records and selected lesson across reload")

            lesson.select_option("power-loop")
            expect(training.get_by_role("heading", name="大迴旋", exact=True)).to_be_visible()
            loop_hud = flight.get_by_role("group", name="大迴旋即時狀態", exact=True)
            loop_fields = {
                "progress_degrees": flight.get_by_test_id("loop-progress"),
                "height_gain_m": flight.get_by_test_id("loop-height"),
                "forward_span_m": flight.get_by_test_id("loop-span"),
            }

            def loop_motion() -> dict:
                values = {}
                for key, field in loop_fields.items():
                    expect(field).to_be_visible()
                    match = re.match(r"^[+-]?\d+(?:\.\d+)?", field.inner_text())
                    if not match:
                        raise AssertionError(f"L13 spatial loop readout is not numeric: {key}.")
                    values[key] = float(match.group())
                return values

            original_loop_canvas = canvas.element_handle()
            before_loop_demo = training_progress(page)
            prior_loop_steps = training.get_by_role("list", name="本課步驟", exact=True).get_by_role("listitem").all_text_contents()
            if len(prior_loop_steps) != 8:
                raise AssertionError("L13 does not expose eight ground-to-spatial-loop checkpoints.")
            expect(loop_hud).to_contain_text("即時")
            flight.get_by_role("button", name="L13 大迴旋示範", exact=True).click()
            expect(flight.get_by_role("button", name="0.5×", exact=True)).to_have_attribute("aria-pressed", "true")
            expect(arm).to_be_disabled()
            expect(lesson).to_be_disabled()
            flight.get_by_role("button", name="Pause", exact=True).click()
            expect(loop_hud).to_contain_text("回放")
            timeline.press("Home")
            demonstration_snapshot("L13", 8)
            expect(altitude).to_have_text("0.0 m")
            home_loop = loop_motion()
            if any(abs(value) > .05 for value in home_loop.values()):
                raise AssertionError(f"L13 does not begin with supported ground and zero loop dimensions: {home_loop}")
            loop_chapters = demo_progress.get_by_role("list", name="示範步驟", exact=True).get_by_role("button")
            loop_chapters.nth(3).click()
            loop_entry_height = float(altitude.inner_text().split()[0])
            if loop_entry_height < 24:
                raise AssertionError(f"L13 demonstration starts pulling the loop below the new 25 m recommendation: {loop_entry_height} m.")
            if screenshot:
                flight.locator(".free-flight-viewport").screenshot(path=str(artifact_dir / "l13-higher-entry.png"))
            timeline.press("End")
            demonstration_snapshot("L13", 8, complete=True)
            end_loop = loop_motion()
            if end_loop["progress_degrees"] < 325 or end_loop["height_gain_m"] < 3 or end_loop["forward_span_m"] < 6:
                raise AssertionError(f"L13 completion does not show a spatial loop: {end_loop}")
            if float(altitude.inner_text().split()[0]) < 1.5:
                raise AssertionError("L13 ends on the ground instead of recovering in flight.")
            held_loop_position = position_hud.inner_text()
            page.wait_for_timeout(200)
            if loop_motion() != end_loop or position_hud.inner_text() != held_loop_position:
                raise AssertionError("L13 paused ghost or spatial measurements kept advancing.")
            if screenshot:
                flight.locator(".free-flight-viewport").screenshot(path=str(artifact_dir / "l13-demonstration-end.png"))
                flight.get_by_role("button", name="Chase", exact=True).click()
                flight.locator(".free-flight-viewport").screenshot(path=str(artifact_dir / "l13-demonstration-chase.png"))
                flight.get_by_role("button", name="Free / debug", exact=True).click()
                flight.locator(".free-flight-viewport").screenshot(path=str(artifact_dir / "l13-demonstration-free.png"))
                flight.get_by_role("button", name="FPV", exact=True).click()
            loop_chapters = demo_progress.get_by_role("list", name="示範步驟", exact=True).get_by_role("button")
            loop_chapters.nth(5).click()
            expect(flight.get_by_role("button", name="Play", exact=True)).to_be_enabled()
            expect(demo_progress).to_contain_text("5 / 8 個示範步驟完成")
            over_top_loop = loop_motion()
            if over_top_loop["progress_degrees"] < 140 or over_top_loop["height_gain_m"] < 3:
                raise AssertionError(f"L13 over-top chapter lacks a climbed, inverted loop: {over_top_loop}")
            loop_chapter_time = float(timeline.input_value())
            page.wait_for_timeout(200)
            if abs(float(timeline.input_value()) - loop_chapter_time) > .02 or loop_motion() != over_top_loop:
                raise AssertionError("L13 chapter seeking did not pause its own clock and measured dimensions.")
            report["power_loop_course"] = {
                "lesson_id": "power-loop", "course_code": "L13", "home": home_loop, "end": end_loop,
                "entry_height_m": loop_entry_height,
                "over_top": {"time_seconds": loop_chapter_time, **over_top_loop},
            }
            if screenshot:
                page.locator(".free-flight-layout").evaluate("layout => window.scrollTo({top: layout.getBoundingClientRect().top + window.scrollY - 8, behavior: 'instant'})")
                page.screenshot(path=str(artifact_dir / "l13-demonstration-over-top.png"))
            report["power_loop_hud_layouts"] = {}
            for width, height in ((1280, 720), (1280, 600), (375, 720)):
                page.set_viewport_size({"width": width, "height": height})
                position_hud.scroll_into_view_if_needed()
                viewport_bounds = flight.locator(".free-flight-viewport").bounding_box()
                loop_bounds = loop_hud.bounding_box()
                if not viewport_bounds or not loop_bounds:
                    raise AssertionError(f"L13 instruments have no layout bounds at {width}x{height}.")
                if (loop_bounds['x'] < viewport_bounds['x']
                        or loop_bounds['x'] + loop_bounds['width'] > viewport_bounds['x'] + viewport_bounds['width']
                        or loop_bounds['y'] < viewport_bounds['y']
                        or loop_bounds['y'] + loop_bounds['height'] > viewport_bounds['y'] + viewport_bounds['height']):
                    raise AssertionError(f"L13 instruments overflow the viewport at {width}x{height}.")
                for other, label in ((position_hud.bounding_box(), "position HUD"), (flight.locator(".flight-safe-overlay").bounding_box(), "playback banner")):
                    if not other:
                        raise AssertionError(f"L13 {label} has no bounds at {width}x{height}.")
                    overlap_x = min(loop_bounds['x'] + loop_bounds['width'], other['x'] + other['width']) - max(loop_bounds['x'], other['x'])
                    overlap_y = min(loop_bounds['y'] + loop_bounds['height'], other['y'] + other['height']) - max(loop_bounds['y'], other['y'])
                    if overlap_x > 0 and overlap_y > 0:
                        raise AssertionError(f"L13 instruments overlap {label} at {width}x{height}.")
                report["power_loop_hud_layouts"][f"{width}x{height}"] = {"loop_hud": loop_bounds, "viewport": viewport_bounds}
                if screenshot and width == 375:
                    flight.locator(".free-flight-viewport").screenshot(path=str(artifact_dir / "l13-hud-375.png"))
            page.set_viewport_size({"width": 1280, "height": 720})
            loop_chapters.nth(3).click()
            expect(demo_progress).to_contain_text("3 / 8 個示範步驟完成")
            timeline.press("Home")
            demonstration_snapshot("L13", 8)
            expect(altitude).to_have_text("0.0 m")
            if loop_motion() != home_loop:
                raise AssertionError("L13 Home seek does not restore its own initial dimensions.")
            timeline.press("End")
            demonstration_snapshot("L13", 8, complete=True)
            flight.get_by_role("button", name="結束示範", exact=True).click()
            expect(arm).to_be_enabled()
            expect(disarm).to_be_disabled()
            expect(loop_hud).to_contain_text("即時")
            expect(demo_progress).to_have_count(0)
            expect(training.get_by_role("list", name="本課步驟", exact=True).get_by_role("listitem")).to_have_text(prior_loop_steps)
            if not original_loop_canvas or not original_loop_canvas.evaluate("element => element === document.querySelector('#free-flight canvas')"):
                raise AssertionError("L13 demonstration replaced the shared live flight canvas.")
            if training_progress(page) != before_loop_demo:
                raise AssertionError("L13 demonstration wrote a live attempt or saved result.")
            flight.get_by_role("button", name="俯仰", exact=True).click()
            flight.get_by_role("button", name="Pause", exact=True).click()
            timeline.press("End")
            demonstration_snapshot("L00", 5, complete=True)
            expect(loop_hud).to_have_count(0)
            flight.get_by_role("button", name="結束示範", exact=True).click()
            expect(loop_hud).to_be_visible()
            expect(lesson).to_have_value("power-loop")
            if training_progress(page) != before_loop_demo:
                raise AssertionError("L00 pitch illustration changed the selected L13 loop result.")
            page.reload(wait_until="networkidle")
            expect(lesson).to_have_value("power-loop")
            source.select_option("keyboard")
            expect(training.locator(".school-progress")).to_contain_text("已練 0 次")
            checks.append("L13 physical spatial loop demo, measured rise and span, eight independent chapters, half-speed, pause and rewind with live-result isolation")
            checks.append("L13 loop dimensions fit desktop, short desktop and mobile without overlapping altitude/XYZ or playback banner")
            checks.append("L13 selection persists across reload while L00 pitch illustration and prior saved results remain independent")

            lesson.select_option("split-s")
            expect(training.get_by_role("heading", name="破S", exact=True)).to_be_visible()
            split_hud = flight.get_by_role("group", name="破S即時狀態", exact=True)
            split_fields = {
                "roll_degrees": flight.get_by_test_id("split-roll"),
                "pitch_degrees": flight.get_by_test_id("split-pitch"),
                "height_loss_m": flight.get_by_test_id("split-descent"),
            }

            def split_motion() -> dict:
                values = {}
                for key, field in split_fields.items():
                    expect(field).to_be_visible()
                    match = re.match(r"^[+-]?\d+(?:\.\d+)?", field.inner_text())
                    if not match:
                        raise AssertionError(f"L14 roll-then-dive readout is not numeric: {key}.")
                    values[key] = float(match.group())
                return values

            original_split_canvas = canvas.element_handle()
            before_split_demo = training_progress(page)
            prior_split_steps = training.get_by_role("list", name="本課步驟", exact=True).get_by_role("listitem").all_text_contents()
            if len(prior_split_steps) != 8:
                raise AssertionError("L14 does not expose eight ground-to-descending-reversal checkpoints.")
            expect(split_hud).to_contain_text("即時")
            flight.get_by_role("button", name="L14 破S示範", exact=True).click()
            expect(flight.get_by_role("button", name="0.5×", exact=True)).to_have_attribute("aria-pressed", "true")
            expect(arm).to_be_disabled()
            expect(lesson).to_be_disabled()
            flight.get_by_role("button", name="Pause", exact=True).click()
            expect(split_hud).to_contain_text("回放")
            timeline.press("Home")
            demonstration_snapshot("L14", 8)
            expect(altitude).to_have_text("0.0 m")
            home_split = split_motion()
            if any(abs(value) > .05 for value in home_split.values()):
                raise AssertionError(f"L14 does not begin with supported ground and zero roll, pitch and descent: {home_split}")
            timeline.press("End")
            demonstration_snapshot("L14", 8, complete=True)
            end_split = split_motion()
            if end_split["roll_degrees"] < 140 or end_split["pitch_degrees"] < 145 or end_split["height_loss_m"] < 3:
                raise AssertionError(f"L14 completion does not show the roll, pitch and actual descent: {end_split}")
            if float(altitude.inner_text().split()[0]) < 1.5:
                raise AssertionError("L14 ends on the ground instead of recovering in flight.")
            held_split_position = position_hud.inner_text()
            page.wait_for_timeout(200)
            if split_motion() != end_split or position_hud.inner_text() != held_split_position:
                raise AssertionError("L14 paused ghost or recorded maneuver measurements kept advancing.")
            if screenshot:
                flight.locator(".free-flight-viewport").screenshot(path=str(artifact_dir / "l14-demonstration-end.png"))
                flight.get_by_role("button", name="Chase", exact=True).click()
                flight.locator(".free-flight-viewport").screenshot(path=str(artifact_dir / "l14-demonstration-chase.png"))
                flight.get_by_role("button", name="Free / debug", exact=True).click()
                flight.locator(".free-flight-viewport").screenshot(path=str(artifact_dir / "l14-demonstration-free.png"))
                flight.get_by_role("button", name="FPV", exact=True).click()
            split_chapters = demo_progress.get_by_role("list", name="示範步驟", exact=True).get_by_role("button")
            split_chapters.nth(4).click()
            expect(flight.get_by_role("button", name="Play", exact=True)).to_be_enabled()
            expect(demo_progress).to_contain_text("4 / 8 個示範步驟完成")
            inverted_split = split_motion()
            if inverted_split["roll_degrees"] < 140:
                raise AssertionError(f"L14 inversion chapter lacks an actual half roll: {inverted_split}")
            split_chapter_time = float(timeline.input_value())
            page.wait_for_timeout(200)
            if abs(float(timeline.input_value()) - split_chapter_time) > .02 or split_motion() != inverted_split:
                raise AssertionError("L14 chapter seeking did not pause its own clock and measured dimensions.")
            report["split_s_course"] = {
                "lesson_id": "split-s", "course_code": "L14", "home": home_split, "end": end_split,
                "inverted": {"time_seconds": split_chapter_time, **inverted_split},
            }
            if screenshot:
                page.locator(".free-flight-layout").evaluate("layout => window.scrollTo({top: layout.getBoundingClientRect().top + window.scrollY - 8, behavior: 'instant'})")
                page.screenshot(path=str(artifact_dir / "l14-demonstration-inverted.png"))
                flight.get_by_role("button", name="Free / debug", exact=True).click()
                flight.get_by_role("button", name="定位飛機", exact=True).click()
                for _ in range(9):
                    flight.get_by_role("button", name="降低鏡頭 1 m", exact=True).click()
                canvas.scroll_into_view_if_needed()
                reference_bounds = canvas.bounding_box()
                page.mouse.move(reference_bounds["x"] + reference_bounds["width"] * .7,
                    reference_bounds["y"] + reference_bounds["height"] * .7)
                page.mouse.wheel(0, 1200)
                page.wait_for_timeout(100)
                flight.locator(".free-flight-viewport").screenshot(path=str(artifact_dir / "l14-reference-gantry-free.png"))
                report["split_reference_view"] = canvas.evaluate("""element => ({
                    position: JSON.parse(element.dataset.freeCameraPosition),
                    target: JSON.parse(element.dataset.freeCameraTarget),
                    distance: Number(element.dataset.freeCameraDistance)
                })""")
                flight.get_by_role("button", name="FPV", exact=True).click()
            report["split_s_hud_layouts"] = {}
            for width, height in ((1280, 720), (1280, 600), (375, 720)):
                page.set_viewport_size({"width": width, "height": height})
                position_hud.scroll_into_view_if_needed()
                viewport_bounds = flight.locator(".free-flight-viewport").bounding_box()
                split_bounds = split_hud.bounding_box()
                if not viewport_bounds or not split_bounds:
                    raise AssertionError(f"L14 instruments have no layout bounds at {width}x{height}.")
                if (split_bounds['x'] < viewport_bounds['x']
                        or split_bounds['x'] + split_bounds['width'] > viewport_bounds['x'] + viewport_bounds['width']
                        or split_bounds['y'] < viewport_bounds['y']
                        or split_bounds['y'] + split_bounds['height'] > viewport_bounds['y'] + viewport_bounds['height']):
                    raise AssertionError(f"L14 instruments overflow the viewport at {width}x{height}.")
                for other, label in ((position_hud.bounding_box(), "position HUD"), (flight.locator(".flight-safe-overlay").bounding_box(), "playback banner")):
                    if not other:
                        raise AssertionError(f"L14 {label} has no bounds at {width}x{height}.")
                    overlap_x = min(split_bounds['x'] + split_bounds['width'], other['x'] + other['width']) - max(split_bounds['x'], other['x'])
                    overlap_y = min(split_bounds['y'] + split_bounds['height'], other['y'] + other['height']) - max(split_bounds['y'], other['y'])
                    if overlap_x > 0 and overlap_y > 0:
                        raise AssertionError(f"L14 instruments overlap {label} at {width}x{height}.")
                if page.evaluate("document.documentElement.scrollWidth > innerWidth + 1"):
                    raise AssertionError(f"L14 controls or demonstration toolbar overflow the page at {width}x{height}.")
                report["split_s_hud_layouts"][f"{width}x{height}"] = {"split_hud": split_bounds, "viewport": viewport_bounds}
                if screenshot and width == 375:
                    flight.locator(".free-flight-viewport").screenshot(path=str(artifact_dir / "l14-hud-375.png"))
            page.set_viewport_size({"width": 1280, "height": 720})
            split_chapters.nth(3).click()
            expect(demo_progress).to_contain_text("3 / 8 個示範步驟完成")
            timeline.press("Home")
            demonstration_snapshot("L14", 8)
            expect(altitude).to_have_text("0.0 m")
            if split_motion() != home_split:
                raise AssertionError("L14 Home seek does not restore its own initial dimensions.")
            timeline.press("End")
            demonstration_snapshot("L14", 8, complete=True)
            flight.get_by_role("button", name="結束示範", exact=True).click()
            expect(arm).to_be_enabled()
            expect(disarm).to_be_disabled()
            expect(split_hud).to_contain_text("即時")
            expect(demo_progress).to_have_count(0)
            expect(training.get_by_role("list", name="本課步驟", exact=True).get_by_role("listitem")).to_have_text(prior_split_steps)
            if not original_split_canvas or not original_split_canvas.evaluate("element => element === document.querySelector('#free-flight canvas')"):
                raise AssertionError("L14 demonstration replaced the shared live flight canvas.")
            if training_progress(page) != before_split_demo:
                raise AssertionError("L14 demonstration wrote a live attempt or saved result.")
            flight.get_by_role("button", name="橫滾", exact=True).click()
            flight.get_by_role("button", name="Pause", exact=True).click()
            timeline.press("End")
            demonstration_snapshot("L00", 5, complete=True)
            expect(split_hud).to_have_count(0)
            flight.get_by_role("button", name="結束示範", exact=True).click()
            expect(split_hud).to_be_visible()
            expect(lesson).to_have_value("split-s")
            if training_progress(page) != before_split_demo:
                raise AssertionError("L00 roll illustration changed the selected L14 result.")
            page.reload(wait_until="networkidle")
            expect(lesson).to_have_value("split-s")
            source.select_option("keyboard")
            expect(training.locator(".school-progress")).to_contain_text("已練 0 次")
            checks.append("L14 physical half roll and descending pitch half-loop demo, measured rotation and height loss, eight independent chapters, half-speed, pause and rewind with live-result isolation")
            checks.append("L14 roll and descent instruments fit desktop, short desktop and mobile without overlapping altitude/XYZ or playback banner")
            checks.append("L14 selection persists across reload while L00 roll illustration and prior saved results remain independent")

            lesson.select_option("orbit")
            expect(training.get_by_role("heading", name="正刷鍋", exact=True)).to_be_visible()
            orbit_hud = flight.get_by_role("group", name="正刷鍋即時狀態", exact=True)
            orbit_fields = {
                "completed_laps": flight.get_by_test_id("orbit-laps"),
                "progress_degrees": flight.get_by_test_id("orbit-progress"),
                "radius_m": flight.get_by_test_id("orbit-radius"),
                "heading_error_degrees": flight.get_by_test_id("orbit-heading"),
            }

            def orbit_motion() -> dict:
                values = {}
                for key, field in orbit_fields.items():
                    expect(field).to_be_visible()
                    match = re.match(r"^[+-]?\d+(?:\.\d+)?", field.inner_text())
                    if not match:
                        raise AssertionError(f"L15 measured orbit readout is not numeric: {key}.")
                    values[key] = float(match.group())
                return values

            original_orbit_canvas = canvas.element_handle()
            before_orbit_demo = training_progress(page)
            prior_orbit_steps = training.get_by_role("list", name="本課步驟", exact=True).get_by_role("listitem").all_text_contents()
            if len(prior_orbit_steps) != 9:
                raise AssertionError("L15 does not expose nine ground-to-five-circle checkpoints.")
            expect(orbit_hud).to_contain_text("即時")
            flight.get_by_role("button", name="L15 正刷鍋示範", exact=True).click()
            expect(flight.get_by_role("button", name="0.5×", exact=True)).to_have_attribute("aria-pressed", "true")
            expect(arm).to_be_disabled()
            expect(lesson).to_be_disabled()
            flight.get_by_role("button", name="Pause", exact=True).click()
            expect(orbit_hud).to_contain_text("回放")
            timeline.press("Home")
            demonstration_snapshot("L15", 9)
            expect(altitude).to_have_text("0.0 m")
            home_orbit = orbit_motion()
            if abs(home_orbit["progress_degrees"]) > .05 or home_orbit["completed_laps"] != 0 or abs(home_orbit["radius_m"] - 30) > .15:
                raise AssertionError(f"L15 does not begin at the actual ground launch relative to its target: {home_orbit}")
            if screenshot:
                flight.locator(".free-flight-viewport").screenshot(path=str(artifact_dir / "l15-demonstration-ground.png"))
            timeline.press("End")
            demonstration_snapshot("L15", 9, complete=True)
            end_orbit = orbit_motion()
            if end_orbit["progress_degrees"] < 1800 or end_orbit["completed_laps"] != 5 or end_orbit["radius_m"] < 18:
                raise AssertionError(f"L15 completion does not show five full circles followed by an outward departure: {end_orbit}")
            if float(altitude.inner_text().split()[0]) < 1.5:
                raise AssertionError("L15 ends on the ground instead of recovering in flight.")
            held_orbit_position = position_hud.inner_text()
            paused_orbit_time = float(timeline.input_value())
            page.wait_for_timeout(200)
            if orbit_motion() != end_orbit or position_hud.inner_text() != held_orbit_position or abs(float(timeline.input_value()) - paused_orbit_time) > .02:
                raise AssertionError("L15 paused ghost, movie clock or recorded orbit measurements kept advancing.")
            if screenshot:
                flight.locator(".free-flight-viewport").screenshot(path=str(artifact_dir / "l15-demonstration-end.png"))
                flight.get_by_role("button", name="Chase", exact=True).click()
                flight.locator(".free-flight-viewport").screenshot(path=str(artifact_dir / "l15-demonstration-chase.png"))
                flight.get_by_role("button", name="Free / debug", exact=True).click()
                flight.get_by_role("button", name="定位飛機", exact=True).click()
                canvas.scroll_into_view_if_needed()
                orbit_bounds = canvas.bounding_box()
                page.mouse.move(orbit_bounds["x"] + orbit_bounds["width"] * .7,
                    orbit_bounds["y"] + orbit_bounds["height"] * .7)
                page.mouse.wheel(0, 1000)
                page.wait_for_timeout(100)
                flight.locator(".free-flight-viewport").screenshot(path=str(artifact_dir / "l15-reference-orbit-free.png"))
                flight.get_by_role("button", name="FPV", exact=True).click()
            orbit_chapters = demo_progress.get_by_role("list", name="示範步驟", exact=True).get_by_role("button")
            expect(orbit_chapters).to_have_count(9)
            recorded_laps = {}
            for completed_laps in range(1, 6):
                # The next chapter begins after the preceding full-circle proof.
                orbit_chapters.nth(completed_laps + 3).click()
                expect(flight.get_by_role("button", name="Play", exact=True)).to_be_enabled()
                snapshot = demonstration_snapshot("L15", 9)
                if snapshot["completed"] != completed_laps + 3:
                    raise AssertionError(f"L15 lap {completed_laps} chapter has the wrong observed checkpoint count: {snapshot}")
                lap = orbit_motion()
                if lap["completed_laps"] != completed_laps or not (360 * completed_laps - .05 <= lap["progress_degrees"] < 360 * (completed_laps + 1)):
                    raise AssertionError(f"L15 lap {completed_laps} chapter does not show {completed_laps} complete 360-degree circles: {lap}")
                if not (6 <= lap["radius_m"] <= 30) or lap["heading_error_degrees"] > 80:
                    raise AssertionError(f"L15 lap {completed_laps} is not an actual target-facing orbit: {lap}")
                recorded_laps[completed_laps] = {"time_seconds": float(timeline.input_value()), **lap}
                if screenshot:
                    flight.locator(".free-flight-viewport").screenshot(path=str(artifact_dir / f"l15-demonstration-lap-{completed_laps}.png"))
            # Even the fifth circle is followed by a distinct controlled-exit step.
            expect(demo_progress).to_contain_text("8 / 9 個示範步驟完成")
            orbit_chapters.nth(6).click()
            expect(demo_progress).to_contain_text("6 / 9 個示範步驟完成")
            three_laps = orbit_motion()
            three_lap_time = float(timeline.input_value())
            page.wait_for_timeout(200)
            if abs(float(timeline.input_value()) - three_lap_time) > .02 or orbit_motion() != three_laps:
                raise AssertionError("L15 three-circle chapter did not pause its own clock and measured path.")
            orbit_chapters.nth(4).click()
            expect(demo_progress).to_contain_text("4 / 9 個示範步驟完成")
            if orbit_motion() != {key: recorded_laps[1][key] for key in orbit_fields} or abs(float(timeline.input_value()) - recorded_laps[1]["time_seconds"]) > .02:
                raise AssertionError("L15 backward chapter seek kept future lap counts or measured dimensions.")
            report["orbit_course"] = {"lesson_id": "orbit", "course_code": "L15", "home": home_orbit,
                "completed_lap_chapters": recorded_laps,
                "end": {"time_seconds": paused_orbit_time, **end_orbit}}
            report["orbit_hud_layouts"] = {}
            for width, height in ((1280, 720), (1280, 600), (375, 720)):
                page.set_viewport_size({"width": width, "height": height})
                position_hud.scroll_into_view_if_needed()
                viewport_bounds = flight.locator(".free-flight-viewport").bounding_box()
                orbit_bounds = orbit_hud.bounding_box()
                if not viewport_bounds or not orbit_bounds:
                    raise AssertionError(f"L15 instruments have no layout bounds at {width}x{height}.")
                if (orbit_bounds['x'] < viewport_bounds['x']
                        or orbit_bounds['x'] + orbit_bounds['width'] > viewport_bounds['x'] + viewport_bounds['width']
                        or orbit_bounds['y'] < viewport_bounds['y']
                        or orbit_bounds['y'] + orbit_bounds['height'] > viewport_bounds['y'] + viewport_bounds['height']):
                    raise AssertionError(f"L15 instruments overflow the viewport at {width}x{height}.")
                for other, label in ((position_hud.bounding_box(), "position HUD"), (flight.locator(".flight-safe-overlay").bounding_box(), "playback banner")):
                    if not other:
                        raise AssertionError(f"L15 {label} has no bounds at {width}x{height}.")
                    overlap_x = min(orbit_bounds['x'] + orbit_bounds['width'], other['x'] + other['width']) - max(orbit_bounds['x'], other['x'])
                    overlap_y = min(orbit_bounds['y'] + orbit_bounds['height'], other['y'] + other['height']) - max(orbit_bounds['y'], other['y'])
                    if overlap_x > 0 and overlap_y > 0:
                        raise AssertionError(f"L15 instruments overlap {label} at {width}x{height}.")
                if page.evaluate("document.documentElement.scrollWidth > innerWidth + 1"):
                    raise AssertionError(f"L15 controls or demonstration toolbar overflow the page at {width}x{height}.")
                report["orbit_hud_layouts"][f"{width}x{height}"] = {"orbit_hud": orbit_bounds, "viewport": viewport_bounds}
                if screenshot and width == 375:
                    flight.locator(".free-flight-viewport").screenshot(path=str(artifact_dir / "l15-hud-375.png"))
            page.set_viewport_size({"width": 1280, "height": 720})
            timeline.press("Home")
            demonstration_snapshot("L15", 9)
            expect(altitude).to_have_text("0.0 m")
            if orbit_motion() != home_orbit:
                raise AssertionError("L15 Home seek does not restore its own ground-start measurements.")
            timeline.press("End")
            demonstration_snapshot("L15", 9, complete=True)
            flight.get_by_role("button", name="結束示範", exact=True).click()
            expect(arm).to_be_enabled()
            expect(disarm).to_be_disabled()
            expect(orbit_hud).to_contain_text("即時")
            expect(demo_progress).to_have_count(0)
            expect(training.get_by_role("list", name="本課步驟", exact=True).get_by_role("listitem")).to_have_text(prior_orbit_steps)
            if not original_orbit_canvas or not original_orbit_canvas.evaluate("element => element === document.querySelector('#free-flight canvas')"):
                raise AssertionError("L15 demonstration replaced the shared live flight canvas.")
            if training_progress(page) != before_orbit_demo:
                raise AssertionError("L15 demonstration wrote a live attempt or saved result.")
            flight.get_by_role("button", name="橫滾", exact=True).click()
            flight.get_by_role("button", name="Pause", exact=True).click()
            timeline.press("End")
            demonstration_snapshot("L00", 5, complete=True)
            expect(orbit_hud).to_have_count(0)
            flight.get_by_role("button", name="結束示範", exact=True).click()
            expect(orbit_hud).to_be_visible()
            expect(lesson).to_have_value("orbit")
            if training_progress(page) != before_orbit_demo:
                raise AssertionError("L00 roll illustration changed the selected L15 result.")
            page.reload(wait_until="networkidle")
            expect(lesson).to_have_value("orbit")
            source.select_option("keyboard")
            expect(training.locator(".school-progress")).to_contain_text("已練 0 次")
            checks.append("L15 physical target-facing five-circle orbit demo, five measured 360-degree laps, nine independent chapters, separate controlled exit, pause and rewind without live-result writes")
            checks.append("L15 orbit progress, radius and target-heading instruments fit desktop, short desktop and mobile with the altitude/XYZ and playback banner")
            checks.append("L15 orbit selection and unchanged live checkpoints persist across reload and separate L00 roll playback")

            lesson.select_option("reverse-orbit")
            expect(training.get_by_role("heading", name="倒刷鍋", exact=True)).to_be_visible()
            reverse_orbit_hud = flight.get_by_role("group", name="倒刷鍋即時狀態", exact=True)
            reverse_orbit_fields = {
                "completed_laps": flight.get_by_test_id("reverse-orbit-laps"),
                "progress_degrees": flight.get_by_test_id("reverse-orbit-progress"),
                "radius_m": flight.get_by_test_id("reverse-orbit-radius"),
                "view_elevation_degrees": flight.get_by_test_id("reverse-orbit-view-elevation"),
                "target_error_degrees": flight.get_by_test_id("reverse-orbit-target-error"),
            }

            def reverse_orbit_motion() -> dict:
                values = {}
                for key, field in reverse_orbit_fields.items():
                    expect(field).to_be_visible()
                    match = re.match(r"^[+-]?\d+(?:\.\d+)?", field.inner_text())
                    if not match:
                        raise AssertionError(f"L16 measured reverse_orbit readout is not numeric: {key}.")
                    values[key] = float(match.group())
                return values

            original_reverse_orbit_canvas = canvas.element_handle()
            before_reverse_orbit_demo = training_progress(page)
            prior_reverse_orbit_steps = training.get_by_role("list", name="本課步驟", exact=True).get_by_role("listitem").all_text_contents()
            if len(prior_reverse_orbit_steps) != 7:
                raise AssertionError("L16 does not expose seven ground-to-three-circle checkpoints.")
            expect(reverse_orbit_hud).to_contain_text("即時")
            flight.get_by_role("button", name="L16 倒刷鍋示範", exact=True).click()
            expect(flight.get_by_role("button", name="0.5×", exact=True)).to_have_attribute("aria-pressed", "true")
            expect(arm).to_be_disabled()
            expect(lesson).to_be_disabled()
            flight.get_by_role("button", name="Pause", exact=True).click()
            expect(reverse_orbit_hud).to_contain_text("回放")
            timeline.press("Home")
            demonstration_snapshot("L16", 7)
            expect(altitude).to_have_text("0.0 m")
            home_reverse_orbit = reverse_orbit_motion()
            if abs(home_reverse_orbit["progress_degrees"]) > .05 or home_reverse_orbit["completed_laps"] != 0 or abs(home_reverse_orbit["radius_m"] - 30) > .15:
                raise AssertionError(f"L16 does not begin at the actual ground launch relative to its target: {home_reverse_orbit}")
            if screenshot:
                flight.locator(".free-flight-viewport").screenshot(path=str(artifact_dir / "l16-demonstration-ground.png"))
            timeline.press("End")
            demonstration_snapshot("L16", 7, complete=True)
            end_reverse_orbit = reverse_orbit_motion()
            if end_reverse_orbit["progress_degrees"] < 1080 or end_reverse_orbit["completed_laps"] != 3 or end_reverse_orbit["radius_m"] < 13:
                raise AssertionError(f"L16 completion does not show three full circles followed by an outward departure: {end_reverse_orbit}")
            if not math.isclose(float(altitude.inner_text().split()[0]), 22.5, abs_tol=.75):
                raise AssertionError("L16 does not recover near half the 45 m crane height (22.5 m).")
            held_reverse_orbit_position = position_hud.inner_text()
            paused_reverse_orbit_time = float(timeline.input_value())
            page.wait_for_timeout(200)
            if reverse_orbit_motion() != end_reverse_orbit or position_hud.inner_text() != held_reverse_orbit_position or abs(float(timeline.input_value()) - paused_reverse_orbit_time) > .02:
                raise AssertionError("L16 paused ghost, movie clock or recorded reverse_orbit measurements kept advancing.")
            if screenshot:
                flight.locator(".free-flight-viewport").screenshot(path=str(artifact_dir / "l16-demonstration-end.png"))
                flight.get_by_role("button", name="Chase", exact=True).click()
                flight.locator(".free-flight-viewport").screenshot(path=str(artifact_dir / "l16-demonstration-chase.png"))
                demo_progress.get_by_role("list", name="示範步驟", exact=True).get_by_role("button").nth(5).click()
                flight.get_by_role("button", name="Free / debug", exact=True).click()
                flight.get_by_role("button", name="定位飛機", exact=True).click()
                canvas.scroll_into_view_if_needed()
                reverse_orbit_bounds = canvas.bounding_box()
                page.mouse.move(reverse_orbit_bounds["x"] + reverse_orbit_bounds["width"] * .7,
                    reverse_orbit_bounds["y"] + reverse_orbit_bounds["height"] * .7)
                page.mouse.wheel(0, 1700)
                for _ in range(9):
                    flight.get_by_role("button", name="升高鏡頭 1 m", exact=True).click()
                for _ in range(10):
                    flight.get_by_role("button", name="前移鏡頭 1 m", exact=True).click()
                for _ in range(2):
                    flight.get_by_role("button", name="左移鏡頭 1 m", exact=True).click()
                page.wait_for_timeout(150)
                flight.locator(".free-flight-viewport").screenshot(path=str(artifact_dir / "l16-reference-reverse-orbit-free.png"))
                flight.get_by_role("button", name="FPV", exact=True).click()
            reverse_orbit_chapters = demo_progress.get_by_role("list", name="示範步驟", exact=True).get_by_role("button")
            expect(reverse_orbit_chapters).to_have_count(7)
            recorded_laps = {}
            for completed_laps in range(1, 4):
                # The next chapter begins after the preceding full-circle proof.
                reverse_orbit_chapters.nth(completed_laps + 3).click()
                expect(flight.get_by_role("button", name="Play", exact=True)).to_be_enabled()
                snapshot = demonstration_snapshot("L16", 7)
                if snapshot["completed"] != completed_laps + 3:
                    raise AssertionError(f"L16 lap {completed_laps} chapter has the wrong observed checkpoint count: {snapshot}")
                lap = reverse_orbit_motion()
                if lap["completed_laps"] != completed_laps or not (360 * completed_laps - .05 <= lap["progress_degrees"] < 360 * (completed_laps + 1)):
                    raise AssertionError(f"L16 lap {completed_laps} chapter does not show {completed_laps} complete 360-degree circles: {lap}")
                if not (4 <= lap["radius_m"] <= 35) or lap["view_elevation_degrees"] < 35 or lap["target_error_degrees"] > 45:
                    raise AssertionError(f"L16 lap {completed_laps} is not an actual upward-looking crane orbit: {lap}")
                lap_altitude_m = float(altitude.inner_text().split()[0])
                if not math.isclose(lap_altitude_m, 22.5, abs_tol=.75):
                    raise AssertionError(f"L16 lap {completed_laps} is not near half the crane height: {lap_altitude_m} m.")
                recorded_laps[completed_laps] = {"time_seconds": float(timeline.input_value()), "altitude_m": lap_altitude_m, **lap}
                if screenshot:
                    flight.locator(".free-flight-viewport").screenshot(path=str(artifact_dir / f"l16-demonstration-lap-{completed_laps}.png"))
            # The third full circle still needs a separate actual outward departure.
            expect(demo_progress).to_contain_text("6 / 7 個示範步驟完成")
            reverse_orbit_chapters.nth(5).click()
            expect(demo_progress).to_contain_text("5 / 7 個示範步驟完成")
            two_laps = reverse_orbit_motion()
            two_lap_time = float(timeline.input_value())
            page.wait_for_timeout(200)
            if abs(float(timeline.input_value()) - two_lap_time) > .02 or reverse_orbit_motion() != two_laps:
                raise AssertionError("L16 two-circle chapter did not pause its own clock and measured path.")
            reverse_orbit_chapters.nth(4).click()
            expect(demo_progress).to_contain_text("4 / 7 個示範步驟完成")
            if reverse_orbit_motion() != {key: recorded_laps[1][key] for key in reverse_orbit_fields} or abs(float(timeline.input_value()) - recorded_laps[1]["time_seconds"]) > .02:
                raise AssertionError("L16 backward chapter seek kept future lap counts or measured dimensions.")
            lap_one_position = {
                "x_m": float(flight.get_by_test_id("flight-position-right").inner_text().split()[0]),
                "z_m": float(flight.get_by_test_id("flight-position-z").inner_text().split()[0]),
            }
            middle_time = (recorded_laps[1]["time_seconds"] + recorded_laps[2]["time_seconds"]) / 2
            timeline.evaluate("""(element, value) => {
                Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(element, value);
                element.dispatchEvent(new Event('input', { bubbles: true }));
                element.dispatchEvent(new Event('change', { bubbles: true }));
            }""", str(middle_time))
            middle_motion = reverse_orbit_motion()
            middle_position = {
                "x_m": float(flight.get_by_test_id("flight-position-right").inner_text().split()[0]),
                "z_m": float(flight.get_by_test_id("flight-position-z").inner_text().split()[0]),
            }
            if (not (360 <= middle_motion["progress_degrees"] < 720)
                    or middle_motion["view_elevation_degrees"] < 35
                    or middle_motion["target_error_degrees"] > 45
                    or math.hypot(middle_position["x_m"] - lap_one_position["x_m"], middle_position["z_m"] - lap_one_position["z_m"]) < 8):
                raise AssertionError(f"L16 does not actually travel to the opposite side of the crane while looking up: {middle_motion}, {middle_position}")
            if screenshot:
                flight.locator(".free-flight-viewport").screenshot(path=str(artifact_dir / "l16-demonstration-opposite-side-fpv.png"))
            reverse_orbit_chapters.nth(4).click()
            report["reverse_orbit_course"] = {"lesson_id": "reverse-orbit", "course_code": "L16", "home": home_reverse_orbit,
                "completed_lap_chapters": recorded_laps,
                "opposite_side": {"time_seconds": middle_time, **middle_position, **middle_motion},
                "end": {"time_seconds": paused_reverse_orbit_time, **end_reverse_orbit}}
            report["reverse_orbit_hud_layouts"] = {}
            for width, height in ((1280, 720), (1280, 600), (375, 720)):
                page.set_viewport_size({"width": width, "height": height})
                position_hud.scroll_into_view_if_needed()
                viewport_bounds = flight.locator(".free-flight-viewport").bounding_box()
                reverse_orbit_bounds = reverse_orbit_hud.bounding_box()
                if not viewport_bounds or not reverse_orbit_bounds:
                    raise AssertionError(f"L16 instruments have no layout bounds at {width}x{height}.")
                if (reverse_orbit_bounds['x'] < viewport_bounds['x']
                        or reverse_orbit_bounds['x'] + reverse_orbit_bounds['width'] > viewport_bounds['x'] + viewport_bounds['width']
                        or reverse_orbit_bounds['y'] < viewport_bounds['y']
                        or reverse_orbit_bounds['y'] + reverse_orbit_bounds['height'] > viewport_bounds['y'] + viewport_bounds['height']):
                    raise AssertionError(f"L16 instruments overflow the viewport at {width}x{height}.")
                for other, label in ((position_hud.bounding_box(), "position HUD"), (flight.locator(".flight-safe-overlay").bounding_box(), "playback banner")):
                    if not other:
                        raise AssertionError(f"L16 {label} has no bounds at {width}x{height}.")
                    overlap_x = min(reverse_orbit_bounds['x'] + reverse_orbit_bounds['width'], other['x'] + other['width']) - max(reverse_orbit_bounds['x'], other['x'])
                    overlap_y = min(reverse_orbit_bounds['y'] + reverse_orbit_bounds['height'], other['y'] + other['height']) - max(reverse_orbit_bounds['y'], other['y'])
                    if overlap_x > 0 and overlap_y > 0:
                        raise AssertionError(f"L16 instruments overlap {label} at {width}x{height}.")
                # The high crane anchor projects near the top of the upward
                # FPV view. Both instrument panels must leave that region clear.
                position_bounds = position_hud.bounding_box()
                if not position_bounds or min(reverse_orbit_bounds["y"], position_bounds["y"]) < viewport_bounds["y"] + 125:
                    raise AssertionError(f"L16 instrument dock obscures the overhead crane reference at {width}x{height}.")
                if page.evaluate("document.documentElement.scrollWidth > innerWidth + 1"):
                    raise AssertionError(f"L16 controls or demonstration toolbar overflow the page at {width}x{height}.")
                report["reverse_orbit_hud_layouts"][f"{width}x{height}"] = {"reverse_orbit_hud": reverse_orbit_bounds, "viewport": viewport_bounds}
                if screenshot and width == 375:
                    flight.locator(".free-flight-viewport").screenshot(path=str(artifact_dir / "l16-hud-375.png"))
            page.set_viewport_size({"width": 1280, "height": 720})
            timeline.press("Home")
            demonstration_snapshot("L16", 7)
            expect(altitude).to_have_text("0.0 m")
            if reverse_orbit_motion() != home_reverse_orbit:
                raise AssertionError("L16 Home seek does not restore its own ground-start measurements.")
            timeline.press("End")
            demonstration_snapshot("L16", 7, complete=True)
            flight.get_by_role("button", name="結束示範", exact=True).click()
            expect(arm).to_be_enabled()
            expect(disarm).to_be_disabled()
            expect(reverse_orbit_hud).to_contain_text("即時")
            expect(demo_progress).to_have_count(0)
            expect(training.get_by_role("list", name="本課步驟", exact=True).get_by_role("listitem")).to_have_text(prior_reverse_orbit_steps)
            if not original_reverse_orbit_canvas or not original_reverse_orbit_canvas.evaluate("element => element === document.querySelector('#free-flight canvas')"):
                raise AssertionError("L16 demonstration replaced the shared live flight canvas.")
            if training_progress(page) != before_reverse_orbit_demo:
                raise AssertionError("L16 demonstration wrote a live attempt or saved result.")
            flight.get_by_role("button", name="橫滾", exact=True).click()
            flight.get_by_role("button", name="Pause", exact=True).click()
            timeline.press("End")
            demonstration_snapshot("L00", 5, complete=True)
            expect(reverse_orbit_hud).to_have_count(0)
            flight.get_by_role("button", name="結束示範", exact=True).click()
            expect(reverse_orbit_hud).to_be_visible()
            expect(lesson).to_have_value("reverse-orbit")
            if training_progress(page) != before_reverse_orbit_demo:
                raise AssertionError("L00 roll illustration changed the selected L16 result.")
            page.reload(wait_until="networkidle")
            expect(lesson).to_have_value("reverse-orbit")
            source.select_option("keyboard")
            expect(training.locator(".school-progress")).to_contain_text("已練 0 次")
            checks.append("L16 physical upward-looking crane orbit, three measured full 360-degree laps, seven independent chapters and a separate actual departure; pause and rewind without live-result writes")
            checks.append("L16 lower instrument dock preserves the overhead crane view on desktop, short desktop and mobile with altitude/XYZ and playback banner")
            checks.append("L16 crane orbit selection and unchanged live checkpoints persist across reload and separate L00 roll playback")

            lesson.select_option("backward-flight")
            expect(training.get_by_role("heading", name="後退飛行", exact=True)).to_be_visible()
            backward_hud = flight.get_by_role("group", name="後退飛行即時狀態", exact=True)
            backward_fields = {
                "yaw_degrees": flight.get_by_test_id("backward-yaw"),
                "backward_speed_mps": flight.get_by_test_id("backward-speed"),
                "distance_m": flight.get_by_test_id("backward-distance"),
            }
            backward_direction = flight.get_by_test_id("backward-motion-direction")

            def backward_motion() -> dict:
                values = {}
                for key, field in backward_fields.items():
                    expect(field).to_be_visible()
                    match = re.match(r"^[+-]?\d+(?:\.\d+)?", field.inner_text())
                    if not match:
                        raise AssertionError(f"L17 measured motion readout is not numeric: {key}.")
                    values[key] = float(match.group())
                values["direction"] = backward_direction.inner_text()
                return values

            original_backward_canvas = canvas.element_handle()
            before_backward_demo = training_progress(page)
            prior_backward_steps = training.get_by_role("list", name="本課步驟", exact=True).get_by_role("listitem").all_text_contents()
            if len(prior_backward_steps) != 7:
                raise AssertionError("L17 does not expose seven ground-to-backward-flight checkpoints.")
            expect(backward_hud).to_contain_text("即時")
            expect(backward_hud).to_contain_text("青色雙柱")
            expect(backward_hud).to_contain_text("金色三柱")
            flight.get_by_role("button", name="L17 後退飛行示範", exact=True).click()
            expect(flight.get_by_role("button", name="0.5×", exact=True)).to_have_attribute("aria-pressed", "true")
            expect(arm).to_be_disabled()
            expect(lesson).to_be_disabled()
            flight.get_by_role("button", name="Pause", exact=True).click()
            expect(backward_hud).to_contain_text("回放")
            timeline.press("Home")
            demonstration_snapshot("L17", 7)
            expect(altitude).to_have_text("0.0 m")
            home_backward = backward_motion()
            if abs(home_backward["yaw_degrees"]) > .05 or abs(home_backward["distance_m"]) > .05 or abs(home_backward["backward_speed_mps"]) > .05:
                raise AssertionError(f"L17 does not begin on actual ground without prior turn or backward credit: {home_backward}")
            if screenshot:
                flight.locator(".free-flight-viewport").screenshot(path=str(artifact_dir / "l17-demonstration-ground.png"))
            timeline.press("End")
            demonstration_snapshot("L17", 7, complete=True)
            end_backward = backward_motion()
            if end_backward["distance_m"] < 3 or end_backward["yaw_degrees"] < 120:
                raise AssertionError(f"L17 completion lacks actual backward travel after a reversed heading: {end_backward}")
            if float(altitude.inner_text().split()[0]) < 1.5:
                raise AssertionError("L17 ends on the ground instead of recovering in flight.")
            held_backward_position = position_hud.inner_text()
            paused_backward_time = float(timeline.input_value())
            page.wait_for_timeout(200)
            if backward_motion() != end_backward or position_hud.inner_text() != held_backward_position or abs(float(timeline.input_value()) - paused_backward_time) > .02:
                raise AssertionError("L17 paused ghost, independent clock or recorded backward motion kept advancing.")
            if screenshot:
                flight.locator(".free-flight-viewport").screenshot(path=str(artifact_dir / "l17-demonstration-end.png"))
            backward_chapters = demo_progress.get_by_role("list", name="示範步驟", exact=True).get_by_role("button")
            expect(backward_chapters).to_have_count(7)
            backward_chapters.nth(3).click()
            expect(demo_progress).to_contain_text("3 / 7 個示範步驟完成")
            forward_backward = backward_motion()
            forward_time = float(timeline.input_value())
            forward_z = float(flight.get_by_test_id("flight-position-z").inner_text().split()[0])
            if forward_backward["backward_speed_mps"] >= -.5:
                raise AssertionError(f"L17 forward chapter has no actual prior forward momentum: {forward_backward}")
            backward_chapters.nth(5).click()
            expect(demo_progress).to_contain_text("5 / 7 個示範步驟完成")
            moving_backward = backward_motion()
            moving_time = float(timeline.input_value())
            moving_z = float(flight.get_by_test_id("flight-position-z").inner_text().split()[0])
            if moving_backward["yaw_degrees"] < 120 or moving_backward["backward_speed_mps"] < .7 or "後退" not in moving_backward["direction"] or moving_z >= forward_z:
                raise AssertionError(f"L17 turn does not preserve travel while the nose reverses: {moving_backward}, forwardz={forward_z}, movingz={moving_z}")
            page.wait_for_timeout(200)
            if backward_motion() != moving_backward or abs(float(timeline.input_value()) - moving_time) > .02:
                raise AssertionError("L17 chapter seek did not pause backward-flight measurements and its own clock.")
            if screenshot:
                flight.locator(".free-flight-viewport").screenshot(path=str(artifact_dir / "l17-demonstration-backward-fpv.png"))
            backward_chapters.nth(6).click()
            expect(demo_progress).to_contain_text("6 / 7 個示範步驟完成")
            maintained_backward = backward_motion()
            maintained_z = float(flight.get_by_test_id("flight-position-z").inner_text().split()[0])
            if maintained_backward["distance_m"] < 3 or maintained_z >= moving_z:
                raise AssertionError(f"L17 maintained chapter does not show sustained real movement: {maintained_backward}")
            for camera_name in ("Chase", "Free / debug", "FPV"):
                camera = flight.get_by_role("button", name=camera_name, exact=True)
                camera.click()
                expect(camera).to_have_attribute("aria-pressed", "true")
                if camera_name == "Free / debug":
                    flight.get_by_role("button", name="定位飛機", exact=True).click()
                    canvas.scroll_into_view_if_needed()
                    backward_bounds = canvas.bounding_box()
                    page.mouse.move(backward_bounds["x"] + backward_bounds["width"] * .7,
                        backward_bounds["y"] + backward_bounds["height"] * .7)
                    page.mouse.wheel(0, 1000)
                    page.wait_for_timeout(100)
                if screenshot:
                    suffix = {"Chase": "chase", "Free / debug": "free", "FPV": "fpv"}[camera_name]
                    flight.locator(".free-flight-viewport").screenshot(path=str(artifact_dir / f"l17-reference-{suffix}.png"))
            backward_chapters.nth(3).click()
            expect(demo_progress).to_contain_text("3 / 7 個示範步驟完成")
            if backward_motion() != forward_backward or abs(float(timeline.input_value()) - forward_time) > .02:
                raise AssertionError("L17 backward seek retained future turn angle, speed or travel distance.")
            backward_chapters.nth(5).click()
            report["backward_flight_course"] = {"lesson_id": "backward-flight", "course_code": "L17", "home": home_backward,
                "forward": {"time_seconds": forward_time, "z_m": forward_z, **forward_backward},
                "turned_and_moving": {"time_seconds": moving_time, "z_m": moving_z, **moving_backward},
                "maintained": {"z_m": maintained_z, **maintained_backward},
                "end": {"time_seconds": paused_backward_time, **end_backward}}
            report["backward_hud_layouts"] = {}
            for width, height in ((1280, 720), (1280, 600), (375, 720)):
                page.set_viewport_size({"width": width, "height": height})
                position_hud.scroll_into_view_if_needed()
                viewport_bounds = flight.locator(".free-flight-viewport").bounding_box()
                backward_bounds = backward_hud.bounding_box()
                if not viewport_bounds or not backward_bounds:
                    raise AssertionError(f"L17 instruments have no layout bounds at {width}x{height}.")
                if (backward_bounds['x'] < viewport_bounds['x']
                        or backward_bounds['x'] + backward_bounds['width'] > viewport_bounds['x'] + viewport_bounds['width']
                        or backward_bounds['y'] < viewport_bounds['y']
                        or backward_bounds['y'] + backward_bounds['height'] > viewport_bounds['y'] + viewport_bounds['height']):
                    raise AssertionError(f"L17 instruments overflow the viewport at {width}x{height}.")
                for other, label in ((position_hud.bounding_box(), "position HUD"), (flight.locator(".flight-safe-overlay").bounding_box(), "playback banner")):
                    if not other:
                        raise AssertionError(f"L17 {label} has no bounds at {width}x{height}.")
                    overlap_x = min(backward_bounds['x'] + backward_bounds['width'], other['x'] + other['width']) - max(backward_bounds['x'], other['x'])
                    overlap_y = min(backward_bounds['y'] + backward_bounds['height'], other['y'] + other['height']) - max(backward_bounds['y'], other['y'])
                    if overlap_x > 0 and overlap_y > 0:
                        raise AssertionError(f"L17 instruments overlap {label} at {width}x{height}.")
                if page.evaluate("document.documentElement.scrollWidth > innerWidth + 1"):
                    raise AssertionError(f"L17 controls or demonstration toolbar overflow the page at {width}x{height}.")
                report["backward_hud_layouts"][f"{width}x{height}"] = {"backward_hud": backward_bounds, "viewport": viewport_bounds}
                if screenshot and width == 375:
                    flight.locator(".free-flight-viewport").screenshot(path=str(artifact_dir / "l17-hud-375.png"))
            page.set_viewport_size({"width": 1280, "height": 720})
            timeline.press("Home")
            demonstration_snapshot("L17", 7)
            expect(altitude).to_have_text("0.0 m")
            if backward_motion() != home_backward:
                raise AssertionError("L17 Home seek does not restore its own ground-start measurements.")
            timeline.press("End")
            demonstration_snapshot("L17", 7, complete=True)
            flight.get_by_role("button", name="結束示範", exact=True).click()
            expect(arm).to_be_enabled()
            expect(disarm).to_be_disabled()
            expect(backward_hud).to_contain_text("即時")
            expect(demo_progress).to_have_count(0)
            expect(training.get_by_role("list", name="本課步驟", exact=True).get_by_role("listitem")).to_have_text(prior_backward_steps)
            if not original_backward_canvas or not original_backward_canvas.evaluate("element => element === document.querySelector('#free-flight canvas')"):
                raise AssertionError("L17 demonstration replaced the shared live flight canvas.")
            if training_progress(page) != before_backward_demo:
                raise AssertionError("L17 demonstration wrote a live attempt or saved result.")
            flight.get_by_role("button", name="偏航", exact=True).click()
            flight.get_by_role("button", name="Pause", exact=True).click()
            timeline.press("End")
            demonstration_snapshot("L00", 5, complete=True)
            expect(backward_hud).to_have_count(0)
            flight.get_by_role("button", name="結束示範", exact=True).click()
            expect(backward_hud).to_be_visible()
            expect(lesson).to_have_value("backward-flight")
            if training_progress(page) != before_backward_demo:
                raise AssertionError("L00 yaw illustration changed the selected L17 result.")
            page.reload(wait_until="networkidle")
            expect(lesson).to_have_value("backward-flight")
            source.select_option("keyboard")
            expect(training.locator(".school-progress")).to_contain_text("已練 0 次")
            checks.append("L17 physical forward-momentum and upright yaw-reversal demo, measured backward speed and travel, seven independent chapters, pause and rewind without live-result writes")
            checks.append("L17 motion and landmark instruments fit desktop, short desktop and mobile with altitude/XYZ, playback banner and all three cameras")
            checks.append("L17 selection and unchanged live checkpoints persist across reload and separate L00 yaw playback")

            lesson.select_option("gravity-gate")
            expect(training.get_by_role("heading", name="重力門", exact=True)).to_be_visible()
            gravity_hud = flight.get_by_role("group", name="重力門即時狀態", exact=True)
            gravity_status = flight.get_by_test_id("gravity-gate-status")
            gravity_fields = {
                "phase": flight.get_by_test_id("gravity-gate-phase"),
                "top_offset_m": flight.get_by_test_id("gravity-gate-top-offset"),
                "entry_x_m": flight.get_by_test_id("gravity-gate-entry-x"),
                "entry_z_m": flight.get_by_test_id("gravity-gate-entry-z"),
                "side_distance_m": flight.get_by_test_id("gravity-gate-side-distance"),
                "return_speed_mps": flight.get_by_test_id("gravity-gate-return-speed"),
                "return_distance_m": flight.get_by_test_id("gravity-gate-return-distance"),
            }

            def gravity_motion() -> dict:
                values = {}
                for key, field in gravity_fields.items():
                    expect(field).to_be_visible()
                    match = re.match(r"^[+-]?\d+(?:\.\d+)?", field.inner_text())
                    if not match:
                        raise AssertionError(f"L19 measured geometry readout is not numeric: {key}.")
                    values[key] = float(match.group())
                values["status"] = gravity_status.inner_text()
                values["altitude_m"] = float(altitude.inner_text().split()[0])
                return values

            original_gravity_canvas = canvas.element_handle()
            before_gravity_demo = training_progress(page)
            prior_gravity_steps = training.get_by_role("list", name="本課步驟", exact=True).get_by_role("listitem").all_text_contents()
            if len(prior_gravity_steps) != 8:
                raise AssertionError("L19 does not expose eight ground-to-top-entry-and-side-exit checkpoints.")
            flight.get_by_role("button", name="L19 重力門示範", exact=True).click()
            expect(flight.get_by_role("button", name="0.5×", exact=True)).to_have_attribute("aria-pressed", "true")
            expect(arm).to_be_disabled()
            expect(lesson).to_be_disabled()
            flight.get_by_role("button", name="Pause", exact=True).click()
            expect(gravity_hud).to_contain_text("回放")
            timeline.press("Home")
            demonstration_snapshot("L19", 8)
            expect(altitude).to_have_text("0.0 m")
            home_gravity = gravity_motion()
            expect(gravity_status).to_have_text("頂部入 ○ · 低層 ○ · 折返 ○ · 同側出 ○")
            if home_gravity["phase"] > 1 or not math.isclose(home_gravity["top_offset_m"], -14, abs_tol=.15):
                raise AssertionError(f"L19 does not begin on real ground below the smaller 14 m top opening: {home_gravity}")
            if screenshot:
                flight.locator(".free-flight-viewport").screenshot(path=str(artifact_dir / "l19-ground-fpv.png"))
            timeline.press("End")
            demonstration_snapshot("L19", 8, complete=True)
            end_gravity = gravity_motion()
            expect(gravity_status).to_have_text("頂部入 ✓ · 低層 ✓ · 折返 ✓ · 同側出 ✓")
            if (end_gravity["phase"] != 8 or end_gravity["side_distance_m"] >= 0
                    or end_gravity["altitude_m"] < 4 or end_gravity["entry_x_m"] < 4
                    or end_gravity["return_speed_mps"] < .5 or end_gravity["return_distance_m"] < .3):
                raise AssertionError(f"L19 completion lacks actual lower-level reversal and return through the approach side: {end_gravity}")
            held_gravity_time = float(timeline.input_value())
            held_gravity_position = position_hud.inner_text()
            page.wait_for_timeout(200)
            if gravity_motion() != end_gravity or position_hud.inner_text() != held_gravity_position or abs(float(timeline.input_value()) - held_gravity_time) > .02:
                raise AssertionError("L19 pause did not freeze measured motion, position and independent replay clock.")
            gravity_chapters = demo_progress.get_by_role("list", name="示範步驟", exact=True).get_by_role("button")
            expect(gravity_chapters).to_have_count(8)
            gravity_chapters.nth(3).click()
            expect(demo_progress).to_contain_text("3 / 8 個示範步驟完成")
            approaching_gravity = gravity_motion()
            if approaching_gravity["return_speed_mps"] > -1 or approaching_gravity["entry_x_m"] <= 4:
                raise AssertionError(f"L19 does not establish a real inward approach from the marked lateral side: {approaching_gravity}")
            gravity_chapters.nth(6).click()
            expect(demo_progress).to_contain_text("6 / 8 個示範步驟完成")
            entered_gravity = gravity_motion()
            entered_gravity_time = float(timeline.input_value())
            expect(gravity_status).to_have_text("頂部入 ✓ · 低層 ○ · 折返 ○ · 同側出 ○")
            if abs(entered_gravity["entry_x_m"]) >= 4 or abs(entered_gravity["entry_z_m"]) >= 4 or not (-1 <= entered_gravity["top_offset_m"] <= .1):
                raise AssertionError(f"L19 top-entry chapter is not inside the smaller 8 m opening: {entered_gravity}")
            if screenshot:
                flight.locator(".free-flight-viewport").screenshot(path=str(artifact_dir / "l19-top-entry-fpv.png"))
            gravity_chapters.nth(7).click()
            expect(demo_progress).to_contain_text("7 / 8 個示範步驟完成")
            exited_gravity = gravity_motion()
            expect(gravity_status).to_have_text("頂部入 ✓ · 低層 ✓ · 折返 ✓ · 同側出 ✓")
            if (exited_gravity["side_distance_m"] > .1 or not (4 <= exited_gravity["altitude_m"] < 8.9)
                    or exited_gravity["entry_x_m"] < 3.9 or exited_gravity["return_speed_mps"] < .5
                    or exited_gravity["return_distance_m"] < .3):
                raise AssertionError(f"L19 did not descend and reverse through the low opening on the approach side: {exited_gravity}")
            gravity_chapters.nth(4).click()
            expect(demo_progress).to_contain_text("4 / 8 個示範步驟完成")
            expect(gravity_status).to_have_text("頂部入 ○ · 低層 ○ · 折返 ○ · 同側出 ○")
            if gravity_motion()["phase"] != 4:
                raise AssertionError("L19 rewind retained future entry or side-exit proof.")
            gravity_chapters.nth(6).click()
            expect(demo_progress).to_contain_text("6 / 8 個示範步驟完成")
            expect(gravity_status).to_have_text("頂部入 ✓ · 低層 ○ · 折返 ○ · 同側出 ○")
            if gravity_motion() != entered_gravity or abs(float(timeline.input_value()) - entered_gravity_time) > .02:
                raise AssertionError("L19 chapter seek did not restore its measured top-entry facts.")
            report["gravity_gate_course"] = {"lesson_id": "gravity-gate", "course_code": "L19", "home": home_gravity,
                "approach": approaching_gravity, "entered": entered_gravity, "exited": exited_gravity,
                "end": end_gravity, "duration_seconds": held_gravity_time}
            report["gravity_gate_hud_layouts"] = {}
            for width, height in ((1280, 720), (1280, 600), (375, 720)):
                page.set_viewport_size({"width": width, "height": height})
                position_hud.scroll_into_view_if_needed()
                viewport_bounds = flight.locator(".free-flight-viewport").bounding_box()
                gravity_bounds = gravity_hud.bounding_box()
                if not viewport_bounds or not gravity_bounds or (gravity_bounds["x"] < viewport_bounds["x"]
                        or gravity_bounds["x"] + gravity_bounds["width"] > viewport_bounds["x"] + viewport_bounds["width"] + .5
                        or gravity_bounds["y"] < viewport_bounds["y"]
                        or gravity_bounds["y"] + gravity_bounds["height"] > viewport_bounds["y"] + viewport_bounds["height"] + .5):
                    raise AssertionError(f"L19 HUD overflows its viewport at {width}x{height}.")
                for other, label in ((position_hud.bounding_box(), "altitude/XYZ"), (flight.locator(".flight-safe-overlay").bounding_box(), "playback banner")):
                    if not other:
                        raise AssertionError(f"L19 {label} has no layout bounds at {width}x{height}.")
                    overlap_x = min(gravity_bounds["x"] + gravity_bounds["width"], other["x"] + other["width"]) - max(gravity_bounds["x"], other["x"])
                    overlap_y = min(gravity_bounds["y"] + gravity_bounds["height"], other["y"] + other["height"]) - max(gravity_bounds["y"], other["y"])
                    if overlap_x > 0 and overlap_y > 0:
                        raise AssertionError(f"L19 HUD overlaps {label} at {width}x{height}.")
                if page.evaluate("document.documentElement.scrollWidth > innerWidth + 1"):
                    raise AssertionError(f"L19 controls overflow the page at {width}x{height}.")
                report["gravity_gate_hud_layouts"][f"{width}x{height}"] = {"hud": gravity_bounds, "viewport": viewport_bounds}
                if screenshot and width == 375:
                    flight.locator(".free-flight-viewport").screenshot(path=str(artifact_dir / "l19-top-entry-375.png"))
            page.set_viewport_size({"width": 1280, "height": 720})
            for camera_name in ("Chase", "Free / debug", "FPV"):
                camera = flight.get_by_role("button", name=camera_name, exact=True)
                camera.click()
                expect(camera).to_have_attribute("aria-pressed", "true")
                if camera_name == "Free / debug":
                    flight.get_by_role("button", name="定位飛機", exact=True).click()
                    canvas.scroll_into_view_if_needed()
                    gravity_canvas_bounds = canvas.bounding_box()
                    page.mouse.move(gravity_canvas_bounds["x"] + gravity_canvas_bounds["width"] * .7,
                        gravity_canvas_bounds["y"] + gravity_canvas_bounds["height"] * .7)
                    page.mouse.wheel(0, 1200)
                    page.wait_for_timeout(100)
                if screenshot:
                    suffix = {"Chase": "chase", "Free / debug": "free", "FPV": "fpv"}[camera_name]
                    flight.locator(".free-flight-viewport").screenshot(path=str(artifact_dir / f"l19-reference-{suffix}.png"))
            flight.get_by_role("button", name="結束示範", exact=True).click()
            expect(arm).to_be_enabled()
            expect(disarm).to_be_disabled()
            expect(gravity_hud).to_contain_text("即時")
            expect(demo_progress).to_have_count(0)
            expect(training.get_by_role("list", name="本課步驟", exact=True).get_by_role("listitem")).to_have_text(prior_gravity_steps)
            if not original_gravity_canvas or not original_gravity_canvas.evaluate("element => element === document.querySelector('#free-flight canvas')"):
                raise AssertionError("L19 demo replaced the shared live canvas.")
            if training_progress(page) != before_gravity_demo:
                raise AssertionError("L19 demonstration changed a saved live attempt or result.")
            flight.get_by_role("button", name="俯仰", exact=True).click()
            flight.get_by_role("button", name="Pause", exact=True).click()
            timeline.press("End")
            expect(gravity_hud).to_have_count(0)
            flight.get_by_role("button", name="結束示範", exact=True).click()
            expect(gravity_hud).to_be_visible()
            expect(lesson).to_have_value("gravity-gate")
            page.reload(wait_until="networkidle")
            expect(lesson).to_have_value("gravity-gate")
            source.select_option("keyboard")
            expect(training.locator(".school-progress")).to_contain_text("已練 0 次")
            if training_progress(page) != before_gravity_demo:
                raise AssertionError("L19 demo, separate L00 pitch or reload wrote live results.")
            checks.append("L19 physical lateral approach, toss and throttle reduction, downward top entry, lower-level reversal and return through the approach side, eight independent chapters and backward seek without live-result writes")
            checks.append("L19 measured entry and exit HUD preserves altitude/XYZ and playback banner on desktop, short desktop and mobile with all three camera modes")
            checks.append("L19 scene selection and unchanged live checkpoints persist across reload and separate L00 playback")

            # Ground-based lessons wait on actual supported ground and remain
            # safe after arm at zero throttle while the learner prepares to lift off.
            hud = flight.get_by_role("checkbox", name="Developer HUD", exact=True)
            hud.check()
            position = flight.locator(".flight-data-row").filter(
                has=page.get_by_text("Position m", exact=True)
            ).locator("code")
            report["ground_start_positions"] = {}
            for lesson_id in ("landing", "straight-line", "direction-control", "coordinated-turn", "square-route", "figure-eight", "wide-gate", "basic-recovery", "full-roll", "front-flip", "back-flip", "power-loop", "split-s", "orbit", "reverse-orbit", "backward-flight", "gravity-gate"):
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
            lesson.select_option("basic-recovery")
            checks.append("L02/L03/L04/L05/L06/L07/L08/L09/L10/L11/L12/L13/L14/L15/L16/L17/L19 actual ground start, safe low-throttle arm and visible stage guidance")

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

            def free_camera_state() -> dict:
                state = canvas.evaluate("""element => ({
                    position: JSON.parse(element.dataset.freeCameraPosition || 'null'),
                    target: JSON.parse(element.dataset.freeCameraTarget || 'null'),
                    distance: Number(element.dataset.freeCameraDistance)
                })""")
                for field in ("position", "target"):
                    vector = state[field]
                    values = vector if isinstance(vector, list) else [vector.get(axis) for axis in ("x", "y", "z")] if isinstance(vector, dict) else []
                    if len(values) != 3 or not all(isinstance(value, (int, float)) and math.isfinite(value) for value in values):
                        raise AssertionError(f"Free camera has no finite {field}: {state}")
                if not math.isfinite(state["distance"]) or state["distance"] <= 0:
                    raise AssertionError(f"Free camera distance is invalid: {state}")
                return state

            def assert_camera_height_change(before: dict, after: dict, delta_m: float) -> None:
                for field in ("position", "target"):
                    for axis in ("x", "y", "z"):
                        actual = after[field][axis] - before[field][axis]
                        expected = delta_m if axis == "y" else 0
                        if not math.isclose(actual, expected, abs_tol=1e-6):
                            raise AssertionError(f"Camera elevation changed {field}.{axis} by {actual}; expected {expected} m.")
                if not math.isclose(before["distance"], after["distance"], abs_tol=1e-6):
                    raise AssertionError("Changing camera height also changed the viewing distance.")

            def assert_camera_horizontal_change(before: dict, after: dict, right_m: float, forward_m: float) -> None:
                forward_x = before["target"]["x"] - before["position"]["x"]
                forward_z = before["target"]["z"] - before["position"]["z"]
                horizontal_distance = math.hypot(forward_x, forward_z)
                forward_x, forward_z = forward_x / horizontal_distance, forward_z / horizontal_distance
                expected = {"x": -forward_z * right_m + forward_x * forward_m,
                    "y": 0, "z": forward_x * right_m + forward_z * forward_m}
                for field in ("position", "target"):
                    for axis in ("x", "y", "z"):
                        actual = after[field][axis] - before[field][axis]
                        if not math.isclose(actual, expected[axis], abs_tol=1e-6):
                            raise AssertionError(f"Camera horizontal movement changed {field}.{axis} by {actual}; expected {expected[axis]} m.")
                if not math.isclose(before["distance"], after["distance"], abs_tol=1e-6):
                    raise AssertionError("Changing camera horizontal position also changed the viewing distance.")

            def camera_drag(button: str, dx: float, dy: float, shift: bool = False) -> None:
                canvas.scroll_into_view_if_needed()
                bounds = canvas.bounding_box()
                if not bounds:
                    raise AssertionError("Free camera canvas has no bounds.")
                x = bounds["x"] + bounds["width"] * .65
                y = bounds["y"] + bounds["height"] * .75
                page.mouse.move(x, y)
                if shift:
                    page.keyboard.down("Shift")
                page.mouse.down(button=button)
                try:
                    page.mouse.move(x + dx, y + dy, steps=6)
                finally:
                    page.mouse.up(button=button)
                    if shift:
                        page.keyboard.up("Shift")

            def visible_position() -> dict:
                return {key: flight.get_by_test_id(test_id).inner_text() for key, test_id in (
                    ("height", "flight-altitude"), ("right", "flight-position-right"),
                    ("up", "flight-position-up"), ("z", "flight-position-z"))}

            before_free_results = training_progress(page)
            live_position = visible_position()
            flight.get_by_role("button", name="Free / debug", exact=True).click()
            free_help = flight.get_by_label("自由鏡頭操作", exact=True)
            expect(free_help).to_be_visible()
            expect(canvas).to_have_attribute("tabindex", "0")
            flight.get_by_role("button", name="定位飛機", exact=True).click()
            initial_camera = free_camera_state()
            raise_camera = free_help.get_by_role("button", name="升高鏡頭 1 m", exact=True)
            lower_camera = free_help.get_by_role("button", name="降低鏡頭 1 m", exact=True)
            forward_camera = free_help.get_by_role("button", name="前移鏡頭 1 m", exact=True)
            backward_camera = free_help.get_by_role("button", name="後移鏡頭 1 m", exact=True)
            left_camera = free_help.get_by_role("button", name="左移鏡頭 1 m", exact=True)
            right_camera = free_help.get_by_role("button", name="右移鏡頭 1 m", exact=True)
            expect(free_help.get_by_role("group", name="鏡頭移動控制", exact=True)).to_be_visible()
            raise_camera.click()
            raised_camera = free_camera_state()
            assert_camera_height_change(initial_camera, raised_camera, 1)
            expect(raise_camera).to_be_focused()
            raise_camera.press("Enter")
            assert_camera_height_change(initial_camera, free_camera_state(), 2)
            expect(raise_camera).to_be_focused()
            lower_camera.click()
            lower_camera.click()
            assert_camera_height_change(initial_camera, free_camera_state(), 0)
            if visible_position() != live_position or training_progress(page) != before_free_results:
                raise AssertionError("Camera height buttons changed the aircraft position or saved results.")
            report["free_camera_height_buttons"] = {"before": initial_camera, "raised": raised_camera,
                "restored": free_camera_state(), "keyboard_button_focus_retained": True}
            if screenshot:
                page.screenshot(path=str(artifact_dir / "free-camera-height-controls-live.png"))
            checks.append("visible camera height buttons move only world Y by 1 m per activation and retain focus for repeated keyboard activation")
            flight.get_by_role("button", name="定位飛機", exact=True).click()
            initial_camera = free_camera_state()
            camera_drag("left", 70, 20)
            orbited_camera = free_camera_state()
            if orbited_camera["position"] == initial_camera["position"] or orbited_camera["target"] != initial_camera["target"]:
                raise AssertionError("Left drag did not orbit around the retained free-camera target.")
            forward_camera.click()
            forward_once = free_camera_state()
            assert_camera_horizontal_change(orbited_camera, forward_once, 0, 1)
            expect(forward_camera).to_be_focused()
            forward_camera.press("Enter")
            assert_camera_horizontal_change(orbited_camera, free_camera_state(), 0, 2)
            expect(forward_camera).to_be_focused()
            backward_camera.click()
            backward_camera.click()
            assert_camera_horizontal_change(orbited_camera, free_camera_state(), 0, 0)
            left_camera.click()
            left_once = free_camera_state()
            assert_camera_horizontal_change(orbited_camera, left_once, -1, 0)
            right_camera.click()
            assert_camera_horizontal_change(orbited_camera, free_camera_state(), 0, 0)
            if visible_position() != live_position or training_progress(page) != before_free_results:
                raise AssertionError("Camera direction buttons changed the aircraft position or saved results.")
            report["free_camera_direction_buttons"] = {"orbited": orbited_camera, "forward": forward_once,
                "left": left_once, "restored": free_camera_state(), "keyboard_button_focus_retained": True}
            if screenshot:
                page.screenshot(path=str(artifact_dir / "free-camera-direction-controls-live.png"))
            checks.append("visible camera direction buttons translate 1 m along the explored camera yaw on the horizontal plane without aircraft or saved-result writes")
            camera_drag("right", 45, 20)
            panned_camera = free_camera_state()
            if panned_camera["target"] == orbited_camera["target"]:
                raise AssertionError("Right drag did not pan the free-camera target.")
            camera_drag("left", -30, 15, shift=True)
            shifted_camera = free_camera_state()
            if shifted_camera["target"] == panned_camera["target"]:
                raise AssertionError("Shift-left drag did not pan the free camera.")
            bounds = canvas.bounding_box()
            page.mouse.move(bounds["x"] + bounds["width"] * .8, bounds["y"] + bounds["height"] * .8)
            scroll_before_wheel = page.evaluate("scrollY")
            page.mouse.wheel(0, -240)
            page.wait_for_timeout(100)
            zoomed_camera = free_camera_state()
            if zoomed_camera["distance"] >= shifted_camera["distance"]:
                raise AssertionError("Wheel up did not move the free camera closer.")
            if abs(page.evaluate("scrollY") - scroll_before_wheel) > 1:
                raise AssertionError("Free-camera wheel input scrolled the page instead of the camera.")
            if visible_position() != live_position or training_progress(page) != before_free_results:
                raise AssertionError("Free-camera mouse navigation changed the drone or a saved result.")
            expect(arm).to_be_enabled()
            expect(disarm).to_be_disabled()
            report["interactive_free_camera"] = {"initial": initial_camera, "orbited": orbited_camera,
                "panned": panned_camera, "zoomed": zoomed_camera}
            if screenshot:
                canvas.screenshot(path=str(artifact_dir / "interactive-free-camera-live.png"))
            checks.append("live Free camera supports real mouse orbit, right or Shift pan and wheel dolly without changing drone or saved results")

            canvas.focus()
            keyboard_before = free_camera_state()
            page.keyboard.down("ArrowRight")
            page.wait_for_timeout(150)
            page.keyboard.up("ArrowRight")
            keyboard_moved = free_camera_state()
            if keyboard_moved["target"] == keyboard_before["target"]:
                raise AssertionError("Focused arrow keys did not move the free camera.")
            canvas.press("Shift+ArrowLeft")
            keyboard_orbit = free_camera_state()
            if keyboard_orbit["position"] == keyboard_moved["position"] or keyboard_orbit["target"] != keyboard_moved["target"]:
                raise AssertionError("Shift-arrow keys did not orbit the free camera.")
            canvas.press("PageUp")
            keyboard_raised = free_camera_state()
            if keyboard_raised["target"]["y"] <= keyboard_orbit["target"]["y"]:
                raise AssertionError("PageUp did not move the free camera vertically.")
            assert_camera_height_change(keyboard_orbit, keyboard_raised, keyboard_raised["target"]["y"] - keyboard_orbit["target"]["y"])
            canvas.press("PageDown")
            keyboard_lowered = free_camera_state()
            if keyboard_lowered["target"]["y"] >= keyboard_raised["target"]["y"]:
                raise AssertionError("PageDown did not lower the free camera.")
            assert_camera_height_change(keyboard_raised, keyboard_lowered, keyboard_lowered["target"]["y"] - keyboard_raised["target"]["y"])
            canvas.press("Shift+PageUp")
            shifted_raised = free_camera_state()
            if shifted_raised["target"]["y"] <= keyboard_lowered["target"]["y"]:
                raise AssertionError("Holding Shift disabled PageUp camera elevation.")
            assert_camera_height_change(keyboard_lowered, shifted_raised, shifted_raised["target"]["y"] - keyboard_lowered["target"]["y"])
            canvas.press("Home")
            homed_camera = free_camera_state()
            if homed_camera["target"] != initial_camera["target"]:
                raise AssertionError("Home did not refocus the current live drone.")
            page.keyboard.down("ArrowRight")
            page.wait_for_timeout(80)
            flight.get_by_role("button", name="Chase", exact=True).click()
            switched_camera = free_camera_state()
            page.wait_for_timeout(150)
            page.keyboard.up("ArrowRight")
            if free_camera_state() != switched_camera:
                raise AssertionError("Held free-camera motion continued after a camera-mode change.")
            if visible_position() != live_position or training_progress(page) != before_free_results:
                raise AssertionError("Camera keyboard navigation drove or reset the live drone.")
            flight.get_by_role("button", name="FPV", exact=True).click()
            expect(free_help).to_have_count(0)
            inactive_camera = free_camera_state()
            camera_drag("left", 45, 20)
            if free_camera_state() != inactive_camera:
                raise AssertionError("The FPV view still consumed free-camera drag commands.")
            checks.append("focused camera keys move and orbit without flight-input conflicts and release held motion on mode exit")

            # A free camera is also useful while examining a paused maneuver:
            # navigation must leave the movie clock, ghost and live lesson alone.
            flight.get_by_role("button", name="L13 大迴旋示範", exact=True).click()
            flight.get_by_role("button", name="Pause", exact=True).click()
            timeline.press("End")
            demonstration_snapshot("L13", 8, complete=True)
            paused_time = float(timeline.input_value())
            paused_position = visible_position()
            paused_progress = demo_progress.inner_text()
            flight.get_by_role("button", name="Free / debug", exact=True).click()
            flight.get_by_role("button", name="定位飛機", exact=True).click()
            replay_camera = free_camera_state()
            target = replay_camera["target"]
            target_values = target if isinstance(target, list) else [target[axis] for axis in ("x", "y", "z")]
            if target_values[1] < 1.5 or target_values[2] > -10:
                raise AssertionError(f"Refocus used the old ground spawn instead of the paused replay ghost: {replay_camera}")
            raise_camera.click()
            assert_camera_height_change(replay_camera, free_camera_state(), 1)
            lower_camera.click()
            assert_camera_height_change(replay_camera, free_camera_state(), 0)
            forward_camera.click()
            assert_camera_horizontal_change(replay_camera, free_camera_state(), 0, 1)
            backward_camera.click()
            left_camera.click()
            assert_camera_horizontal_change(replay_camera, free_camera_state(), -1, 0)
            right_camera.click()
            assert_camera_horizontal_change(replay_camera, free_camera_state(), 0, 0)
            camera_drag("left", -55, 20)
            canvas.focus()
            canvas.press("PageUp")
            canvas.press("Home")
            page.wait_for_timeout(150)
            if abs(float(timeline.input_value()) - paused_time) > .02 or demo_progress.inner_text() != paused_progress:
                raise AssertionError("Free-camera navigation resumed or seeked the paused demonstration.")
            if visible_position() != paused_position or training_progress(page) != before_free_results:
                raise AssertionError("Free-camera replay inspection changed the ghost or live saved progress.")
            expect(flight.get_by_role("button", name="Play", exact=True)).to_be_enabled()
            report["free_camera_paused_replay"] = {"time_seconds": paused_time, "reframed": replay_camera}
            if screenshot:
                canvas.screenshot(path=str(artifact_dir / "interactive-free-camera-replay.png"))
            checks.append("free camera and refocus inspect the current paused ghost without replay clock, checkpoint or live-progress writes")

            report["free_camera_help_layouts"] = {}
            for width, height in ((1280, 720), (1280, 600), (375, 720)):
                page.set_viewport_size({"width": width, "height": height})
                free_help.scroll_into_view_if_needed()
                helper_bounds = free_help.bounding_box()
                if not helper_bounds or helper_bounds["x"] < 0 or helper_bounds["x"] + helper_bounds["width"] > width + 1:
                    raise AssertionError(f"Free-camera instructions overflow {width}x{height}: {helper_bounds}")
                for button in (raise_camera, lower_camera, forward_camera, backward_camera, left_camera, right_camera):
                    expect(button).to_be_visible()
                    button_bounds = button.bounding_box()
                    if not button_bounds or button_bounds["x"] < helper_bounds["x"] or button_bounds["x"] + button_bounds["width"] > helper_bounds["x"] + helper_bounds["width"] + 1:
                        raise AssertionError(f"Camera elevation button overflows its helper at {width}x{height}: {button_bounds}")
                layout_camera = free_camera_state()
                raise_camera.click()
                assert_camera_height_change(layout_camera, free_camera_state(), 1)
                lower_camera.click()
                assert_camera_height_change(layout_camera, free_camera_state(), 0)
                forward_camera.click()
                assert_camera_horizontal_change(layout_camera, free_camera_state(), 0, 1)
                backward_camera.click()
                left_camera.click()
                assert_camera_horizontal_change(layout_camera, free_camera_state(), -1, 0)
                right_camera.click()
                assert_camera_horizontal_change(layout_camera, free_camera_state(), 0, 0)
                if abs(float(timeline.input_value()) - paused_time) > .02 or visible_position() != paused_position or demo_progress.inner_text() != paused_progress or training_progress(page) != before_free_results:
                    raise AssertionError(f"Camera height controls changed paused replay or saved results at {width}x{height}.")
                for other in (position_hud.bounding_box(), flight.locator(".flight-safe-overlay").bounding_box()):
                    if not other:
                        raise AssertionError("Free-camera position or playback banner has no bounds.")
                    overlap_x = min(helper_bounds['x'] + helper_bounds['width'], other['x'] + other['width']) - max(helper_bounds['x'], other['x'])
                    overlap_y = min(helper_bounds['y'] + helper_bounds['height'], other['y'] + other['height']) - max(helper_bounds['y'], other['y'])
                    if overlap_x > 0 and overlap_y > 0:
                        raise AssertionError(f"Free-camera instructions overlap flight instruments at {width}x{height}.")
                if page.evaluate("document.documentElement.scrollWidth > innerWidth + 1"):
                    raise AssertionError(f"Free-camera controls cause body overflow at {width}x{height}.")
                report["free_camera_help_layouts"][f"{width}x{height}"] = helper_bounds
                if screenshot and width == 375:
                    page.screenshot(path=str(artifact_dir / "interactive-free-camera-mobile.png"))
            page.set_viewport_size({"width": 1280, "height": 720})
            flight.get_by_role("button", name="結束示範", exact=True).click()
            page.wait_for_timeout(100)
            flight.get_by_role("button", name="定位飛機", exact=True).click()
            restored_camera = free_camera_state()
            restored_target = restored_camera["target"]
            restored_values = restored_target if isinstance(restored_target, list) else [restored_target[axis] for axis in ("x", "y", "z")]
            # Replay exit restores the configured free-flight spawn (0.5 m),
            # which settles through ordinary physics; it is not a lesson setup.
            if abs(restored_values[0]) > .01 or abs(restored_values[2]) > .01 or not (0 <= restored_values[1] < 1):
                raise AssertionError("Refocus after replay exit did not return to the current live drone.")
            if training_progress(page) != before_free_results:
                raise AssertionError("Exiting camera inspection wrote a training result.")
            checks.append("free-camera instructions fit desktop, short desktop and mobile and recenter live state after replay exit")

            for camera_name in ("Chase", "Free / debug", "FPV"):
                camera = flight.get_by_role("button", name=camera_name, exact=True)
                camera.click()
                expect(camera).to_have_attribute("aria-pressed", "true")
            checks.append("FPV, Chase and Free camera controls")

            # Reproduce the reported crashed-screen case using ordinary input
            # and real physics, with no pose injection or developer HUD.
            page.get_by_role("button", name="自由飛行", exact=True).click()
            source.select_option("keyboard")
            progress_before_crash = training_progress(page)
            arm.click()
            page.keyboard.down("r")
            try:
                page.wait_for_function("parseFloat(document.querySelector('[data-testid=flight-altitude]')?.textContent || '0') >= 4")
            finally:
                page.keyboard.up("r")
            expect(flight.locator(".flight-state-badge")).to_contain_text("CRASHED", timeout=15_000)
            expect(flight.get_by_role("checkbox", name="Developer HUD", exact=True)).not_to_be_checked()
            expect(position_hud).to_be_visible()
            for coordinate in ("right", "up", "z"):
                expect(flight.get_by_test_id(f"flight-position-{coordinate}")).to_have_text(re.compile(r"^[+-]?\d+\.\d m$"))
            expect(arm).to_be_disabled()
            if training_progress(page) != progress_before_crash:
                raise AssertionError("Free-flight crash wrote a lesson result.")
            if screenshot:
                flight.locator(".free-flight-viewport").screenshot(path=str(artifact_dir / "crashed-with-xyz.png"))
            checks.append("real keyboard climb and ground-impact crash retains altitude and explicit XYZ")

            logo = page.get_by_role("link", name="FPV Drone Trainer home", exact=True)
            expect(logo).to_have_attribute("href", BASE_PATH)
            logo.click()
            page.wait_for_load_state("networkidle")
            if urlsplit(page.url).path != BASE_PATH:
                raise AssertionError("The logo navigated outside the Pages project path.")
            expect(page.locator("#free-flight canvas")).to_be_visible()
            checks.append("logo reload preserves project path")

            report["position_hud_layouts"] = {}
            for width, height in ((1280, 720), (1280, 600), (375, 720)):
                page.set_viewport_size({"width": width, "height": height})
                position_hud.scroll_into_view_if_needed()
                hud_bounds = position_hud.bounding_box()
                banner_bounds = flight.locator(".flight-safe-overlay").bounding_box()
                viewport_bounds = flight.locator(".free-flight-viewport").bounding_box()
                if not hud_bounds or not banner_bounds or not viewport_bounds:
                    raise AssertionError("Position HUD or safe banner has no layout bounds.")
                if hud_bounds['x'] < viewport_bounds['x'] or hud_bounds['x'] + hud_bounds['width'] > viewport_bounds['x'] + viewport_bounds['width']:
                    raise AssertionError(f"Position HUD overflows viewport at {width}x{height}.")
                overlap_x = min(hud_bounds['x'] + hud_bounds['width'], banner_bounds['x'] + banner_bounds['width']) - max(hud_bounds['x'], banner_bounds['x'])
                overlap_y = min(hud_bounds['y'] + hud_bounds['height'], banner_bounds['y'] + banner_bounds['height']) - max(hud_bounds['y'], banner_bounds['y'])
                if overlap_x > 0 and overlap_y > 0:
                    raise AssertionError(f"Position HUD overlaps safe banner at {width}x{height}.")
                motion_bounds = motion_hud.bounding_box()
                if not motion_bounds:
                    raise AssertionError(f"L09 motion HUD has no layout bounds at {width}x{height}.")
                if (motion_bounds['x'] < viewport_bounds['x']
                        or motion_bounds['x'] + motion_bounds['width'] > viewport_bounds['x'] + viewport_bounds['width']
                        or motion_bounds['y'] < viewport_bounds['y']
                        or motion_bounds['y'] + motion_bounds['height'] > viewport_bounds['y'] + viewport_bounds['height']):
                    raise AssertionError(f"L09 motion HUD overflows viewport at {width}x{height}.")
                for other, label in ((hud_bounds, "position HUD"), (banner_bounds, "safe banner")):
                    overlap_x = min(motion_bounds['x'] + motion_bounds['width'], other['x'] + other['width']) - max(motion_bounds['x'], other['x'])
                    overlap_y = min(motion_bounds['y'] + motion_bounds['height'], other['y'] + other['height']) - max(motion_bounds['y'], other['y'])
                    if overlap_x > 0 and overlap_y > 0:
                        raise AssertionError(f"L09 motion HUD overlaps {label} at {width}x{height}.")
                report["position_hud_layouts"][f"{width}x{height}"] = {"hud": hud_bounds, "safe_banner": banner_bounds, "recovery_motion": motion_bounds}
                if screenshot and width == 375:
                    flight.locator(".free-flight-viewport").screenshot(path=str(artifact_dir / "position-hud-375.png"))
            page.set_viewport_size({"width": 1280, "height": 720})
            checks.append("position and L09 motion HUDs fit desktop, short desktop and mobile without overlapping each other or safe banner")

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
