# Controller testing checklist

Phase 1 provides the Controller Lab and deterministic signal-processing tests. This checklist is the manual hardware evidence that automated tests cannot provide. Do not report a transmitter as validated from unit tests alone.

## Browser and device setup

1. Use desktop Chrome or Edge in a secure context and confirm the Gamepad API is available.
2. Connect the transmitter over USB, open Controller Lab, and record browser, OS, transmitter ID, browser-reported index, mapping, axis count and button count.
3. Verify the device appears/disappears in the discovery list when connected/disconnected. A disconnect must clear the selected live snapshot and keep the safety gate locked.
4. Inspect raw axes and buttons before calibration. Do not assume axis ordering or a standard Gamepad mapping.

## Calibration

5. Select the intended device and release Roll, Pitch and Yaw. Leave the transmitter untouched while capturing the approximately 2.5 second center sample.
6. Check the displayed center, min/max, peak-to-peak jitter and standard deviation. If a candidate stick center is unstable, recalibrate before proceeding.
7. Move only Roll fully left/right several times. Confirm the identified axis is unambiguous and the measured endpoints represent the real hardware.
8. Repeat independently for Pitch and Yaw. Confirm no axis is duplicated.
9. Move throttle from minimum to maximum. Confirm it is treated as single-ended and does not require a center.
10. Move each control and verify the virtual channel direction. Toggle only the required inversion and repeat direction verification.
11. Inspect Raw, Calibrated, Normalized, Deadband, Filtered and Final values. Confirm deadband is small and full-stick output remains available.
12. Release the transmitter and run the mandatory three-second neutral stability test. Confirm Roll, Pitch and Yaw remain approximately zero and note the per-channel max/mean/jitter report.
13. Reload the page and confirm a compatible profile loads. Change the device layout/mapping or select another device and confirm the profile is not loaded blindly.
14. Edit inversion/deadband or choose Recalibrate and confirm verification timestamps clear.

## Flight handoff (future phases)

15. Verify the safety gate reports eligible only after device, mapping, endpoints, directions, current finite data and neutral stability all pass.
16. With the transmitter at the documented safe throttle condition, enter Free Flight only after the gate allows it.
17. Leave all sticks untouched and watch Roll/Pitch/Yaw commands for spontaneous increase. Stop immediately if an unexplained command or rotation appears.
18. Move one physical control at a time and verify expected sign and independent response before combined flight.

Record raw/processed screenshots or notes, calibration timestamp/profile version, and any browser console warnings. A passing `npm test`, typecheck, lint or build is automated evidence only; it does not claim browser hardware or real-flight validation.
