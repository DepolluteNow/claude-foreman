import sys
from pathlib import Path

# Add project root to Python path so `from foreman.xxx import yyy` works
sys.path.insert(0, str(Path(__file__).parent.parent))
