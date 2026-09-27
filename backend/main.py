from pathlib import Path
from dotenv import load_dotenv

load_dotenv(Path(__file__).resolve().parent.parent / ".env")

from backend.env_loader import *
import certifi
from fastapi import FastAPI, UploadFile, File, Form
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse

import os
import asyncio
import shutil
import uuid
import io
import zipfile
import requests

from PIL import Image

from backend.services.cloudinary_service import (
    upload_image,
    create_processed_url
)

from backend.planner.planner import create_plan




# ==================================================
# MONGODB + LOGIN AUTHENTICATION
# ==================================================

from datetime import datetime, timedelta, timezone
from dotenv import load_dotenv
from jose import JWTError, jwt
from pymongo import MongoClient
from pydantic import BaseModel
from fastapi import Depends, HTTPException
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from pwdlib import PasswordHash

app = FastAPI(title="AI Image Creative Assistant")


load_dotenv()

MONGO_URI = os.getenv("MONGO_URI")
LOGIN_USERNAME = os.getenv("LOGIN_USERNAME")
LOGIN_PASSWORD = os.getenv("LOGIN_PASSWORD")
JWT_SECRET_KEY = os.getenv("JWT_SECRET_KEY")

if not all([MONGO_URI, LOGIN_USERNAME, LOGIN_PASSWORD, JWT_SECRET_KEY]):
    raise RuntimeError("Missing MONGO_URI, LOGIN_USERNAME, LOGIN_PASSWORD, or JWT_SECRET_KEY in .env")

mongo_client = MongoClient(MONGO_URI, serverSelectionTimeoutMS=10000, tls=True, tlsCAFile=certifi.where())
mongo_client.admin.command("ping")

db = mongo_client["ai_image_tool"]
users_collection = db["users"]

password_hash = PasswordHash.recommended()
security = HTTPBearer()
JWT_ALGORITHM = "HS256"
TOKEN_EXPIRE_MINUTES = 720


class LoginRequest(BaseModel):
    username: str
    password: str


users_collection.update_one(
    {"username": LOGIN_USERNAME},
    {"$set": {
        "username": LOGIN_USERNAME,
        "password_hash": password_hash.hash(LOGIN_PASSWORD),
        "updated_at": datetime.now(timezone.utc)
    }},
    upsert=True
)


def create_access_token(username: str):
    expires = datetime.now(timezone.utc) + timedelta(minutes=TOKEN_EXPIRE_MINUTES)
    return jwt.encode(
        {"sub": username, "exp": expires},
        JWT_SECRET_KEY,
        algorithm=JWT_ALGORITHM
    )


async def require_user(
    credentials: HTTPAuthorizationCredentials = Depends(security)
):
    try:
        payload = jwt.decode(
            credentials.credentials,
            JWT_SECRET_KEY,
            algorithms=[JWT_ALGORITHM]
        )
        username = payload.get("sub")
        if not username or not users_collection.find_one({"username": username}):
            raise HTTPException(status_code=401, detail="Invalid user")
        return username
    except JWTError:
        raise HTTPException(status_code=401, detail="Invalid or expired token")


@app.post("/login")
async def login(data: LoginRequest):
    user = users_collection.find_one({"username": data.username})
    if not user or not password_hash.verify(data.password, user["password_hash"]):
        raise HTTPException(status_code=401, detail="Incorrect username or password")

    return {
        "access_token": create_access_token(user["username"]),
        "token_type": "bearer",
        "expires_in": TOKEN_EXPIRE_MINUTES * 60
    }





# ==================================================
# CORS
# ==================================================

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ==================================================
# HOME
# ==================================================

@app.get("/")
def home():
    return {
        "status": "online",
        "message": "AI Image Creative Assistant Backend"
    }


# ==================================================
# SINGLE IMAGE PROCESSING
# ==================================================

@app.post("/process")
async def process_image(
    image: UploadFile = File(...),
    prompt: str = Form(...)
):

    try:

        os.makedirs(
            "uploads",
            exist_ok=True
        )

        # Remove any folder path from filename
        original_name = os.path.basename(
            image.filename.replace("\\", "/")
        )

        # Generate unique filename
        safe_name = (
            f"{uuid.uuid4()}_{original_name}"
        )

        file_path = os.path.join(
            "uploads",
            safe_name
        )

        # Save image
        with open(
            file_path,
            "wb"
        ) as buffer:

            shutil.copyfileobj(
                image.file,
                buffer
            )

        # Read dimensions
        with Image.open(file_path) as img:

            original_width, original_height = img.size

        # Create plan
        plan = create_plan(prompt)

        if not plan["success"]:
            return plan

        # Upload to Cloudinary
        cloudinary_result = upload_image(
            file_path
        )

        # Create processed image
        processed_url = create_processed_url(
            source_url=cloudinary_result["url"],
            original_width=original_width,
            original_height=original_height,
            target_width=plan["target_width"],
            target_height=plan["target_height"],
            background_prompt=(
                "Naturally extend the existing background"
            )
        )

        return {
            "success": True,

            "original": {
                "width": original_width,
                "height": original_height
            },

            "target": {
                "width": plan["target_width"],
                "height": plan["target_height"]
            },

            "plan": plan,

            "original_cloudinary": (
                cloudinary_result["url"]
            ),

            "processed_image": processed_url
        }

    except Exception as e:

        return {
            "success": False,
            "error": str(e)
        }


# ==================================================
# BATCH IMAGE PROCESSING
# ==================================================

@app.post("/process-batch")
async def process_batch(
    images: list[UploadFile] = File(...),
    prompt: str = Form(...)
):
    if not images:
        return {
            "success": False,
            "error": "No images selected."
        }

    plan = create_plan(prompt)

    if not plan["success"]:
        return plan

    os.makedirs("uploads", exist_ok=True)

    async def process_one(index, image):
        try:
            original_name = os.path.basename(
                image.filename.replace("\\", "/")
            )

            file_data = await image.read()

            safe_name = f"{uuid.uuid4()}_{original_name}"
            file_path = os.path.join("uploads", safe_name)

            await asyncio.to_thread(
                Path(file_path).write_bytes,
                file_data
            )

            def get_dimensions():
                with Image.open(file_path) as img:
                    return img.size

            original_width, original_height = await asyncio.to_thread(
                get_dimensions
            )

            cloudinary_result = await asyncio.to_thread(
                upload_image,
                file_path
            )

            processed_url = await asyncio.to_thread(
                create_processed_url,
                public_id=cloudinary_result["public_id"],
                original_width=original_width,
                original_height=original_height,
                target_width=plan["target_width"],
                target_height=plan["target_height"],
                background_prompt="Naturally extend the existing background"
            )

            return {
                "index": index,
                "filename": original_name,
                "success": True,
                "original": {
                    "width": original_width,
                    "height": original_height
                },
                "target": {
                    "width": plan["target_width"],
                    "height": plan["target_height"]
                },
                "processed_image": processed_url
            }

        except Exception as e:
            return {
                "index": index,
                "filename": os.path.basename(
                    image.filename.replace("\\", "/")
                ),
                "success": False,
                "error": str(e)
            }

    tasks = [
        process_one(index, image)
        for index, image in enumerate(images, start=1)
    ]

    results = await asyncio.gather(*tasks)

    successful = sum(
        1 for item in results
        if item.get("success") is True
    )

    failed = len(results) - successful

    return {
        "success": True,
        "total": len(results),
        "successful": successful,
        "failed": failed,
        "plan": plan,
        "results": results
    }


@app.post("/download-zip")
async def download_zip(data: dict):

    results = data.get(
        "results",
        []
    )


    if not results:

        return {
            "success": False,
            "error": "No processed images available."
        }


    # Create ZIP in memory
    zip_buffer = io.BytesIO()


    successful_count = 0


    with zipfile.ZipFile(
        zip_buffer,
        "w",
        zipfile.ZIP_DEFLATED
    ) as zip_file:


        for index, item in enumerate(
            results,
            start=1
        ):


            # Skip failed images
            if not item.get("success"):
                continue


            image_url = item.get(
                "processed_image"
            )


            if not image_url:
                continue


            try:

                # Download processed image
                response = requests.get(
                    image_url,
                    timeout=60
                )

                response.raise_for_status()


                # Get clean filename
                filename = item.get(
                    "filename",
                    f"image_{index}.jpg"
                )


                filename = os.path.basename(
                    filename.replace("\\", "/")
                )


                # Split filename
                name, extension = (
                    os.path.splitext(filename)
                )


                # Add index to prevent duplicates
                zip_filename = (
                    f"{index:03d}_{name}{extension}"
                )


                # Add image to ZIP
                zip_file.writestr(
                    zip_filename,
                    response.content
                )


                successful_count += 1


            except Exception:

                # Skip image if download fails
                continue


    # No successful downloads
    if successful_count == 0:

        return {
            "success": False,
            "error": (
                "Could not download any "
                "processed images."
            )
        }


    # Move pointer to beginning
    zip_buffer.seek(0)


    # Send ZIP to browser
    return StreamingResponse(

        zip_buffer,

        media_type="application/zip",

        headers={
            "Content-Disposition": (
                'attachment; '
                'filename="processed_images.zip"'
            )
        }
    )




