import os
import time
import requests
import cloudinary
import cloudinary.uploader
from urllib.parse import quote


cloudinary.config(
    cloud_name=os.getenv("CLOUDINARY_CLOUD_NAME"),
    api_key=os.getenv("CLOUDINARY_API_KEY"),
    api_secret=os.getenv("CLOUDINARY_API_SECRET"),
    secure=True,
)


def upload_image(file_path):
    result = cloudinary.uploader.upload(
        file_path,
        resource_type="image",
    )

    return {
        "public_id": result["public_id"],
        "url": result.get("secure_url") or result.get("url"),
    }


def create_processed_url(
    source_url=None,
    public_id=None,
    original_width=0,
    original_height=0,
    target_width=0,
    target_height=0,
    background_prompt="Naturally extend the existing background",
):
    cloud_name = os.getenv("CLOUDINARY_CLOUD_NAME")
    api_key = os.getenv("CLOUDINARY_API_KEY")
    api_secret = os.getenv("CLOUDINARY_API_SECRET")

    if not cloud_name:
        raise RuntimeError("CLOUDINARY_CLOUD_NAME is missing.")

    if not api_key:
        raise RuntimeError("CLOUDINARY_API_KEY is missing.")

    if not api_secret:
        raise RuntimeError("CLOUDINARY_API_SECRET is missing.")

    target_width = int(target_width)
    target_height = int(target_height)

    if target_width <= 0 or target_height <= 0:
        raise RuntimeError("Target dimensions must be greater than zero.")

    # If main.py gives us the original secure URL, use it.
    # This preserves the actual uploaded asset/version/format.
    if source_url:
        base_url = source_url
    elif public_id:
        base_url = (
            f"https://res.cloudinary.com/"
            f"{cloud_name}/image/upload/{public_id}"
        )
    else:
        raise RuntimeError(
            "Cloudinary source URL/public ID is missing."
        )

    marker = "/image/upload/"

    if marker not in base_url:
        raise RuntimeError(
            "Invalid Cloudinary source URL."
        )

    prompt = (
        background_prompt
        + ", seamless continuation of the existing scene, "
        + "preserve the original subject exactly, "
        + "do not stretch, distort, crop, or change the subject"
    )

    encoded_prompt = quote(
        quote(prompt, safe=""),
        safe="",
    )

    # IMPORTANT:
    # Correct Cloudinary order:
    # b_gen_fill -> c_pad -> h -> w
    #
    # c_pad keeps the complete original subject visible,
    # scales it proportionally, and adds padding.
    # b_gen_fill fills that padding naturally.
    transformation = (
        f"b_gen_fill:prompt_{encoded_prompt},"
        f"c_pad,h_{target_height},w_{target_width}"
    )

    processed_url = base_url.replace(
        marker,
        marker + transformation + "/",
        1,
    )

    print()
    print("========================================")
    print("CLOUDINARY PROCESSING")
    print("========================================")
    print("Original :", original_width, "x", original_height)
    print("Target   :", target_width, "x", target_height)
    print("========================================")
    print("Processed URL:")
    print(processed_url)
    print("========================================")

    # Cloudinary can return 420/423 while Generative Fill
    # is still being generated.
    max_attempts = 60
    wait_seconds = 2

    for attempt in range(1, max_attempts + 1):

        try:
            response = requests.get(
                processed_url,
                timeout=30,
                allow_redirects=True,
            )

            status = response.status_code

            print(
                f"Cloudinary check "
                f"{attempt}/{max_attempts} -> HTTP {status}"
            )

            if status == 200:
                print("PROCESSED IMAGE READY")
                print("========================================")
                return processed_url

            if status in (420, 423):
                print(
                    "Cloudinary is generating the image..."
                )

            elif status == 404:
                error_header = response.headers.get(
                    "X-Cld-Error",
                    "",
                )

                print(
                    "Cloudinary 404:",
                    error_header or response.text[:300],
                )

            else:
                print(
                    "Cloudinary response:",
                    response.text[:300],
                )

        except Exception as error:
            print(
                "Cloudinary request error:",
                str(error),
            )

        if attempt < max_attempts:
            time.sleep(wait_seconds)

    raise RuntimeError(
        "Cloudinary Generative Fill timed out "
        "or returned an invalid delivery URL."
    )
