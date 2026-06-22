"""Run the Allokit API server: python run.py"""

import uvicorn

if __name__ == "__main__":
    uvicorn.run("allokit.app:app", host="0.0.0.0", port=8000, reload=True)
