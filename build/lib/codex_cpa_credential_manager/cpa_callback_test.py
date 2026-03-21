from typing import Any, Dict


def run_cpa_callback_test(*args: Any, **kwargs: Any) -> Dict[str, Any]:
    return {
        'success': False,
        'removed': True,
        'error': 'OpenAI OAuth callback test flow has been removed from this project.',
        'api_result': {},
    }
