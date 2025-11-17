"""
Minimal FastAPI backend for enzyme kinetics mobile app
Primary role: Log data to server, provide optional AI analysis
Phone handles all calculations and display
"""

from fastapi import FastAPI, File, UploadFile, HTTPException, BackgroundTasks
from fastapi.middleware.cors import CORSMiddleware
from typing import Optional, Dict, Any, List
from datetime import datetime
import json
import os
import cv2
import numpy as np
from threading import Lock

app = FastAPI(title="Enzyme Kinetic Detector - Backend")

# CORS setup
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# State management
app_lock = Lock()

class AppState:
    def __init__(self):
        self.app_state = "IDLE"
        self.ui_state_text = "State: IDLE"
        self.latest_frame_jpeg = None
        self.scan_history: List[Dict[str, Any]] = []
        self.current_scan_data = None

state = AppState()
RECORDS_DIR = "records"
os.makedirs(RECORDS_DIR, exist_ok=True)


# ============ Status Endpoints ============

@app.get("/status")
async def get_status():
    """Return current app status"""
    with app_lock:
        return {
            "app_state": state.app_state,
            "ui_state_text": state.ui_state_text,
            "active_profile_name": "Mobile Spectrometry",
            "latest_frame_jpeg": None,  # Phone displays its own camera
        }


@app.get("/latest-frame")
async def get_latest_frame():
    """Return latest captured frame (deprecated - phone uses its own camera)"""
    with app_lock:
        if not state.latest_frame_jpeg:
            raise HTTPException(status_code=404, detail="No frame available")
        return {"data": state.latest_frame_jpeg}


# ============ Frame Processing ============

@app.post("/frame")
async def receive_frame(file: UploadFile = File(...)):
    """
    Receive frame from phone
    Phone does all analysis; server just logs the data
    """
    try:
        contents = await file.read()
        
        with app_lock:
            state.latest_frame_jpeg = contents
            
            # Decode for verification only
            nparr = np.frombuffer(contents, np.uint8)
            frame_bgr = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
            
            if frame_bgr is None:
                raise HTTPException(status_code=400, detail="Invalid JPEG")
        
        return {"status": "ok", "frame_size": len(contents)}
        
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# ============ Action Endpoints ============

@app.post("/action/{action}")
async def handle_action(action: str, background_tasks: BackgroundTasks):
    """
    Handle scan control actions from phone
    """
    with app_lock:
        if action == "start-scan":
            state.app_state = "BLANKING_COUNTDOWN"
            state.ui_state_text = "State: BLANKING_COUNTDOWN"
            state.current_scan_data = {
                "timestamp": datetime.now().isoformat(),
                "frames": [],
                "analysis": None
            }
            return {"status": "scan_started"}
        
        elif action == "stop-scan":
            if state.current_scan_data:
                # Log scan to records
                background_tasks.add_task(_save_scan_record, state.current_scan_data)
                state.scan_history.append(state.current_scan_data)
            
            state.app_state = "IDLE"
            state.ui_state_text = "State: IDLE"
            state.current_scan_data = None
            return {"status": "scan_stopped"}
        
        elif action == "proceed-to-scan":
            state.app_state = "SCANNING"
            state.ui_state_text = "State: SCANNING"
            return {"status": "proceeding_to_scan"}
        
        else:
            raise HTTPException(status_code=400, detail=f"Unknown action: {action}")


# ============ Data Management ============

@app.post("/save-result")
async def save_result(result_data: Dict[str, Any]):
    """
    Save complete scan result from phone
    Includes phone's analysis data
    """
    try:
        filename = f"{RECORDS_DIR}/scan_{datetime.now().strftime('%Y%m%d_%H%M%S')}.json"
        
        with open(filename, 'w') as f:
            json.dump(result_data, f, indent=2)
        
        with app_lock:
            state.scan_history.append({
                "timestamp": datetime.now().isoformat(),
                "filename": filename,
                "v0": result_data.get("analysis", {}).get("v0"),
                "r_squared": result_data.get("analysis", {}).get("r_squared")
            })
        
        return {"status": "saved", "filename": filename}
        
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/history")
async def get_scan_history():
    """Get list of all saved scans"""
    with app_lock:
        return {
            "count": len(state.scan_history),
            "scans": state.scan_history[-20:]  # Return last 20
        }


@app.get("/records/{scan_id}")
async def get_scan_record(scan_id: str):
    """Retrieve a specific scan record"""
    try:
        filepath = f"{RECORDS_DIR}/{scan_id}.json"
        
        if not os.path.exists(filepath):
            raise HTTPException(status_code=404, detail="Scan not found")
        
        with open(filepath, 'r') as f:
            data = json.load(f)
        
        return data
        
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# ============ Helper Functions ============

def _save_scan_record(scan_data: Dict[str, Any]):
    """Background task to save scan record"""
    try:
        filename = f"{RECORDS_DIR}/scan_{datetime.now().strftime('%Y%m%d_%H%M%S')}.json"
        with open(filename, 'w') as f:
            json.dump(scan_data, f, indent=2)
        print(f"Saved scan to {filename}")
    except Exception as e:
        print(f"Error saving scan: {e}")


# ============ Health Check ============

@app.get("/health")
async def health_check():
    """Health check endpoint"""
    return {
        "status": "ok",
        "version": "2.0",
        "mode": "phone-first (calculations on device)",
        "scan_count": len(state.scan_history)
    }


@app.get("/")
async def root():
    """Root endpoint"""
    return {
        "app": "Enzyme Kinetic Detector",
        "version": "2.0",
        "description": "Mobile-first spectrometry with on-device analysis",
        "endpoints": {
            "status": "/status",
            "health": "/health",
            "history": "/history"
        }
    }


if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("PORT", 8000))
    uvicorn.run(app, host="https://mobilespectrov2eu-183048999594.europe-west1.run.app", port=port)
