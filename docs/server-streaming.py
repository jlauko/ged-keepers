from fastapi import FastAPI, Request
from fastapi.responses import StreamingResponse
from transformers import AutoModelForCausalLM, AutoTokenizer
import torch, asyncio

# Create the FastAPI app
app = FastAPI()

# Load model and tokenizer once at startup
model_name = "microsoft/phi-2"
tokenizer = AutoTokenizer.from_pretrained(model_name)
model = AutoModelForCausalLM.from_pretrained(model_name, torch_dtype=torch.float32)

@app.post("/generate")
async def generate(request: Request):
    data = await request.json()
    prompt = data["inputs"]

    # Generate text (non-streaming for now)
    inputs = tokenizer(prompt, return_tensors="pt")
    outputs = model.generate(**inputs, max_new_tokens=200)
    text = tokenizer.decode(outputs[0], skip_special_tokens=True)

    # Stream the text back word by word
    async def event_stream():
        for word in text.split():
            yield word + " "
            await asyncio.sleep(0.05)  # simulate gradual streaming
        yield "\n"

    return StreamingResponse(event_stream(), media_type="text/plain")
