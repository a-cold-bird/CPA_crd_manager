import argparse
import json


def main() -> None:
    parser = argparse.ArgumentParser(description='Legacy OAuth CLI entrypoint')
    parser.add_argument('args', nargs='*')
    parser.parse_args()
    payload = {
        'ok': False,
        'removed': True,
        'error': 'OpenAI OAuth login CLI has been removed from this project.',
    }
    print(json.dumps(payload, ensure_ascii=False, indent=2))
    raise SystemExit(1)


if __name__ == '__main__':
    main()
