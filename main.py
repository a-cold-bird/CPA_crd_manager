from pathlib import Path
import sys


def _bootstrap_src_path() -> None:
    root = Path(__file__).resolve().parent
    src = root / "src"
    src_text = str(src)
    if src_text not in sys.path:
        sys.path.insert(0, src_text)


def main() -> None:
    _bootstrap_src_path()
    from codex_cpa_credential_manager.cli import main as cli_main

    cli_main()


if __name__ == "__main__":
    main()
