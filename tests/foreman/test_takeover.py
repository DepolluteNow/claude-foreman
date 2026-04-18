from foreman.ring.takeover import CircleDetector, CircleType


def test_no_circle_on_first_attempt():
    detector = CircleDetector()
    result = detector.check(
        attempt=1,
        changed_files=["src/auth.ts"],
        diff="+ const token = jwt.sign(payload)",
        errors=[],
    )
    assert result is None


def test_same_file_same_region_is_circle():
    detector = CircleDetector()
    detector.check(attempt=1, changed_files=["src/auth.ts"], diff="@@ -40,6 +40,8 @@\n+ line1", errors=[])
    result = detector.check(attempt=2, changed_files=["src/auth.ts"], diff="@@ -40,6 +40,10 @@\n+ line2", errors=[])
    assert result == CircleType.SAME_REGION


def test_same_error_is_circle():
    detector = CircleDetector()
    detector.check(attempt=1, changed_files=["src/auth.ts"], diff="+code", errors=["TS2345: Argument of type"])
    result = detector.check(attempt=2, changed_files=["src/auth.ts"], diff="+code2", errors=["TS2345: Argument of type"])
    assert result == CircleType.SAME_ERROR


def test_net_zero_diff_is_circle():
    detector = CircleDetector()
    detector.check(attempt=1, changed_files=["src/auth.ts"], diff="+ added\n- removed", errors=[])
    result = detector.check(attempt=2, changed_files=["src/auth.ts"], diff="- added\n+ removed", errors=[])
    assert result == CircleType.NET_ZERO


def test_different_files_no_circle():
    detector = CircleDetector()
    detector.check(attempt=1, changed_files=["src/auth.ts"], diff="+code", errors=[])
    result = detector.check(attempt=2, changed_files=["src/login.ts"], diff="+other", errors=[])
    assert result is None


def test_reset_clears_history():
    detector = CircleDetector()
    detector.check(attempt=1, changed_files=["src/auth.ts"], diff="+code", errors=["TS2345"])
    detector.reset()
    result = detector.check(attempt=2, changed_files=["src/auth.ts"], diff="+code", errors=["TS2345"])
    assert result is None
