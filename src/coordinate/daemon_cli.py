"""Entry point for the `coordinated` console script (same as `coordinate daemon`)."""
import sys

from .cli import main

if __name__ == "__main__":
    sys.exit(main(["daemon"]))
