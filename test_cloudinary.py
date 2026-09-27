from backend.services.cloudinary_service import upload_image

result = upload_image("uploads/test.jpg")

print(result)