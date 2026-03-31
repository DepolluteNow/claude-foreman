# 🥊 Task 5: GitHub Actions CI workflow

## Weight Class: Middleweight (hook)

## What to do

Create a CI workflow that runs tests on every push and PR. The project is pure Python (no TypeScript, no Node).

### Create `.github/workflows/ci.yml`

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  test:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        python-version: ["3.10", "3.11", "3.12", "3.13"]

    steps:
      - uses: actions/checkout@v4

      - name: Set up Python ${{ matrix.python-version }}
        uses: actions/setup-python@v5
        with:
          python-version: ${{ matrix.python-version }}

      - name: Install dependencies
        run: |
          python -m pip install --upgrade pip
          pip install -e ".[dev]" 2>/dev/null || pip install -e .
          pip install pytest click

      - name: Run tests
        run: python -m pytest tests/foreman/ -v --tb=short

  lint:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Set up Python
        uses: actions/setup-python@v5
        with:
          python-version: "3.12"

      - name: Install dependencies
        run: |
          python -m pip install --upgrade pip
          pip install ruff

      - name: Lint
        run: ruff check foreman/ tests/
```

### Create the `.github/workflows/` directory

Make sure the directory exists:
```bash
mkdir -p .github/workflows
```

### Notes

- The test matrix covers Python 3.10-3.13 (matching pyproject.toml classifiers)
- `pip install -e .` installs the project in editable mode (picks up click dependency from pyproject.toml)
- The `2>/dev/null || pip install -e .` handles the case where `[dev]` extras don't exist yet
- `ruff` is used for linting — it's fast and doesn't need config (sensible defaults)
- Tests run with `python -m pytest` (not just `pytest`) to ensure correct module resolution

## Verify

Validate the YAML is correct:
```bash
python3 -c "import yaml; yaml.safe_load(open('.github/workflows/ci.yml'))" 2>/dev/null || echo "Install pyyaml to validate, or just check indentation manually"
```

Also, run the tests locally to make sure they pass before pushing:
```bash
python3 -m pytest tests/foreman/ -v
```

## Commit

```bash
git add .github/workflows/ci.yml
git commit -m "ci: add GitHub Actions test and lint workflow"
```
