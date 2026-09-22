# Controller testing checklist

This checklist is reserved for Phase 1 and later. It is intentionally documented before hardware support so manual evidence remains distinct from automated tests.

1. Connect the transmitter and verify browser detection.
2. Select the intended device and record its browser-reported ID, axes, and buttons.
3. Inspect raw axes before calibration; do not assume axis ordering.
4. Center roll, pitch, and yaw without touching the transmitter and complete calibration.
5. Verify calibrated endpoints and throttle's non-centering behavior.
6. Move each physical stick independently and confirm its mapped virtual channel.
7. Verify direction and inversion for roll, pitch, yaw, and throttle.
8. Observe raw, calibrated, normalized, deadband, filtered, and final values.
9. Run the neutral-stability test with hands off the transmitter.
10. Confirm unstable or incompatible profiles block normal flight and explain why.
11. Enter Free Flight only after the safety gate reports valid neutral channels.
12. With throttle at the documented safe condition, verify no spontaneous roll, pitch, or yaw command.

Record browser, operating system, controller ID, calibration version, and observed results. A successful automated test run is not a substitute for this hardware checklist.
