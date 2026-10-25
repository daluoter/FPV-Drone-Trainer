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
            expect(page.get_by_test_id("app-release")).to_have_text("版本 2026.10.24.3")
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
            finally:
                legacy_context.close()
            checks.append("retired hover selection resumes merged L01 without rewriting preferences, knowledge or results")

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
            expect(lesson.locator("option")).to_have_count(13)
            expect(lesson.locator("option[value='hover']")).to_have_count(0)
            active_codes = lesson.locator("option").evaluate_all(
                "options => options.map(option => option.textContent.trim().match(/^L\\d{2}/)?.[0])"
            )
            if active_codes != ["L01", "L02", "L03", "L04", "L05", "L06", "L07", "L08", "L09", "L10", "L11", "L13", "L14"]:
                raise AssertionError(f"Active course numbers do not match the merged curriculum: {active_codes}")
            expect(training.get_by_role("heading", name="起飛與定點懸停", exact=True)).to_be_visible()
            expect(training.get_by_role("list", name="本課步驟", exact=True)).to_contain_text("懸停")
            expect(lesson.locator("option[value='landing']")).to_contain_text("L03")
            expect(lesson.locator("option[value='straight-line']")).to_contain_text("L02")
            expect(lesson.locator("option[value='direction-control']")).to_contain_text("L04")
            expect(lesson.locator("option[value='full-roll']")).to_contain_text("L10")
            expect(lesson.locator("option[value='full-flip']")).to_contain_text("L11")
            expect(lesson.locator("option[value='split-s']")).to_contain_text("L13")
            expect(lesson.locator("option[value='orbit']")).to_contain_text("L14")
            for option in lesson.locator("option").all_text_contents():
                title = re.sub(r"^L\d{2}\s*[·：:]?\s*", "", option.strip())
                if re.search(r"[A-Za-z]", title):
                    raise AssertionError(f"A visible course title still contains English: {option}")
            expect(flight.locator(".school-demo-toolbar").get_by_role("button")).to_have_count(15)
            checks.append("Chinese-only course titles, thirteen active lessons and fifteen distinct demonstrations")
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
            checks.append("default practice mode, thirteen active lessons and persisted practice/challenge isolation")

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

            lesson.select_option("full-flip")
            expect(training.get_by_role("heading", name="前後翻轉", exact=True)).to_be_visible()
            before_flip_demos = training_progress(page)
            prior_flip_steps = training.get_by_role("list", name="本課步驟", exact=True).get_by_role("listitem").all_text_contents()
            if len(prior_flip_steps) != 6:
                raise AssertionError("L11 does not expose six ordered ground-to-recovery checkpoints.")
            original_flip_canvas = canvas.element_handle()
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
                        raise AssertionError(f"L11 flip readout is not numeric: {key}.")
                    values[key] = float(match.group())
                return values

            expect(flip_hud).to_be_visible()
            report["l11_full_flip"] = {}
            report["l11_flip_hud_layouts"] = {}
            for direction, demo_name, rate_sign in (
                ("forward", "L11 前翻示範", 1),
                ("backward", "L11 後翻示範", -1),
            ):
                flight.get_by_role("button", name=demo_name, exact=True).click()
                expect(flight.get_by_role("button", name="0.5×", exact=True)).to_have_attribute("aria-pressed", "true")
                expect(arm).to_be_disabled()
                expect(lesson).to_be_disabled()
                expect(flip_hud).to_contain_text("回放")
                flight.get_by_role("button", name="Pause", exact=True).click()
                timeline.press("Home")
                demonstration_snapshot("L11", 6)
                expect(altitude).to_have_text("0.0 m")
                home_flip = flip_motion()
                if any(abs(value) > .05 for value in home_flip.values()):
                    raise AssertionError(f"{demo_name} does not begin from supported rest: {home_flip}")
                timeline.press("End")
                demonstration_snapshot("L11", 6, complete=True)
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
                    flight.locator(".free-flight-viewport").screenshot(path=str(artifact_dir / f"l11-{direction}-demonstration-end.png"))
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
                report["l11_full_flip"][direction] = {
                    "home": home_flip, "end": end_flip,
                    "inverted": {"time_seconds": chapter_time, **inverted_flip},
                }
                if screenshot:
                    page.locator(".free-flight-layout").evaluate("layout => window.scrollTo({top: layout.getBoundingClientRect().top + window.scrollY - 8, behavior: 'instant'})")
                    page.screenshot(path=str(artifact_dir / f"l11-{direction}-demonstration-inverted.png"))
                report["l11_flip_hud_layouts"][direction] = {}
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
                    report["l11_flip_hud_layouts"][direction][f"{width}x{height}"] = {"flip_hud": flip_bounds, "viewport": viewport_bounds}
                    if screenshot and width == 375:
                        flight.locator(".free-flight-viewport").screenshot(path=str(artifact_dir / f"l11-{direction}-hud-375.png"))
                page.set_viewport_size({"width": 1280, "height": 720})
                flip_chapters.nth(3).click()
                expect(demo_progress).to_contain_text("3 / 6 個示範步驟完成")
                timeline.press("Home")
                demonstration_snapshot("L11", 6)
                expect(altitude).to_have_text("0.0 m")
                if flip_motion() != home_flip:
                    raise AssertionError(f"{demo_name} Home seek does not restore its initial measured values.")
                timeline.press("End")
                demonstration_snapshot("L11", 6, complete=True)
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
            checks.append("L11 forward and backward physical flip demos, signed inverted motion, full-turn recovery, independent seek/pause and live-result isolation")
            checks.append("L11 measured flip HUD fits desktop, short desktop and mobile without overlapping altitude/XYZ or playback banner")

            # The introductory pitch illustration remains a separate five-step
            # lesson even while the actual full-flip course is selected.
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
                raise AssertionError("L00 pitch playback while selecting L11 wrote a full-flip result.")
            page.reload(wait_until="networkidle")
            expect(lesson).to_have_value("full-flip")
            source.select_option("keyboard")
            expect(training.locator(".school-progress")).to_contain_text("已練 0 次")
            lesson.select_option("takeoff")
            expect(training.locator(".school-progress")).to_contain_text("已練 1 次")
            lesson.select_option("full-flip")
            checks.append("L00 pitch illustration stays separate from L11 and both flip demos preserve old records and selected lesson across reload")

            # Ground-based lessons wait on actual supported ground and remain
            # safe after arm at zero throttle while the learner prepares to lift off.
            hud = flight.get_by_role("checkbox", name="Developer HUD", exact=True)
            hud.check()
            position = flight.locator(".flight-data-row").filter(
                has=page.get_by_text("Position m", exact=True)
            ).locator("code")
            report["ground_start_positions"] = {}
            for lesson_id in ("landing", "straight-line", "direction-control", "coordinated-turn", "square-route", "figure-eight", "wide-gate", "basic-recovery", "full-roll", "full-flip"):
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
            checks.append("L02/L03/L04/L05/L06/L07/L08/L09/L10/L11 actual ground start, safe low-throttle arm and visible stage guidance")

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
