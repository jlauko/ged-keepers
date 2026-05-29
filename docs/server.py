from fastapi.responses import StreamingResponse
import asyncio

@app.post("/generate")
async def generate(request: Request):
    data = await request.json()
    prompt = data["inputs"]

    inputs = tokenizer(prompt, return_tensors="pt")
    outputs = model.generate(**inputs, max_new_tokens=200)
    text = tokenizer.decode(outputs[0], skip_special_tokens=True)

    async def event_stream():
        for word in text.split():
            yield word + " "
            await asyncio.sleep(0.05)  # simulate gradual output
        yield "\n"  # final newline

    return StreamingResponse(event_stream(), media_type="text/plain")
