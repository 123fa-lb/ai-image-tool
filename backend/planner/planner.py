import re


def extract_target_size(prompt: str):
    """
    Extract target width and height from a natural-language prompt.
    Supports:
    1200x1800
    1200 × 1800
    1200 by 1800
    """

    pattern = r"(\d{2,5})\s*(?:x|×|by)\s*(\d{2,5})"

    match = re.search(pattern, prompt.lower())

    if not match:
        return None, None

    width = int(match.group(1))
    height = int(match.group(2))

    return width, height


def create_plan(prompt: str):
    width, height = extract_target_size(prompt)

    if not width or not height:
        return {
            "success": False,
            "error": "Target dimensions not found in prompt."
        }

    prompt_lower = prompt.lower()

    preserve_subject = any(
        word in prompt_lower
        for word in [
            "preserve subject",
            "don't stretch",
            "do not stretch",
            "no distortion",
            "preserve product",
            "keep subject"
        ]
    )

    extend_background = any(
        word in prompt_lower
        for word in [
            "extend background",
            "background extension",
            "naturally extend",
            "outpaint",
            "fill background"
        ]
    )

    return {
        "success": True,
        "target_width": width,
        "target_height": height,
        "preserve_subject": preserve_subject,
        "preserve_original_background": extend_background,
        "allow_distortion": False,
        "operation": "adaptive",
        "background_mode": (
            "generative_extend"
            if extend_background
            else "preserve"
        )
    }