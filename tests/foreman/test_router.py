import pytest
from foreman.ring.router import TaskRouter, TaskClassification
from foreman.config import SupervisorConfig


@pytest.fixture
def router():
    return TaskRouter(SupervisorConfig.default())


def test_trivial_rename(router):
    result = router.classify("Rename getUserData to fetchUserData in src/utils/api.ts")
    assert result.complexity == "trivial"


def test_trivial_move(router):
    result = router.classify("Move the helper function from utils.ts to src/lib/helpers.ts")
    assert result.complexity == "trivial"


def test_trivial_add_import(router):
    result = router.classify("Add import for useState in src/components/Login.tsx")
    assert result.complexity == "trivial"


def test_standard_component(router):
    result = router.classify("Create component LoginForm at src/components/LoginForm.tsx with email and password fields")
    assert result.complexity == "standard"


def test_standard_route(router):
    result = router.classify("Add API route POST /api/auth/login at src/app/api/auth/login/route.ts")
    assert result.complexity == "standard"


def test_standard_test(router):
    result = router.classify("Write test for the LoginForm component at tests/components/LoginForm.test.tsx")
    assert result.complexity == "standard"


def test_complex_refactor(router):
    result = router.classify("Refactor the auth middleware to support JWT and API key auth across src/middleware/auth.ts, src/access/authenticated.ts, and src/lib/jwt.ts")
    assert result.complexity == "complex"


def test_complex_many_files(router):
    result = router.classify("Update src/a.ts, src/b.ts, src/c.ts, src/d.ts to use new API")
    assert result.complexity == "complex"


def test_codebase_specific_collection(router):
    result = router.classify("Create Payload collection UserSettings at src/collections/UserSettings.ts with fields: theme, language, notifications")
    assert result.complexity == "codebase_specific"


def test_codebase_specific_hook(router):
    result = router.classify("Add afterChange hook to the Articles collection to trigger revalidation")
    assert result.complexity == "codebase_specific"


def test_trivial_routes_to_swe15(router):
    result = router.classify("Rename getUserData to fetchUserData in src/utils/api.ts")
    assert result.ide == "windsurf"
    assert result.model == "swe1.5"


def test_standard_routes_to_kimi(router):
    result = router.classify("Create component LoginForm at src/components/LoginForm.tsx")
    assert result.ide == "windsurf"
    assert result.model == "kimi"


def test_complex_routes_to_gemini(router):
    result = router.classify("Refactor the auth middleware across src/a.ts, src/b.ts, and src/c.ts")
    assert result.ide == "antigravity"
    assert result.model == "gemini-3.1"


def test_codebase_specific_routes_to_kimi(router):
    result = router.classify("Create Payload collection at src/collections/Foo.ts")
    assert result.ide == "windsurf"
    assert result.model == "kimi"


def test_adaptive_routing_overrides_default(router):
    performance = {
        "gemini-3.1": {"standard": 0.95},
        "kimi": {"standard": 0.60},
    }
    result = router.classify(
        "Create component LoginForm at src/components/LoginForm.tsx",
        model_performance=performance,
    )
    assert result.model == "gemini-3.1"
    assert result.ide == "antigravity"
