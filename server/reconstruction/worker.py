#!/usr/bin/env python3
"""Local native reconstruction worker for Aerotrace."""
import argparse
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path


def emit(out, stage, status, message, **extra):
    payload = {"stage": stage, "status": status, "message": message, **extra}
    (out / "stage.json").write_text(json.dumps(payload, indent=2), encoding="utf-8")
    print(json.dumps(payload), flush=True)


def run(cmd, cwd, log):
    with open(log, "a", encoding="utf-8") as stream:
        stream.write("\n$ " + " ".join(map(str, cmd)) + "\n")
        stream.flush()
        return subprocess.run([str(part) for part in cmd], cwd=str(cwd), stdout=stream, stderr=subprocess.STDOUT, check=False).returncode


def command(name, *alternatives):
    explicit = {
        "InterfaceCOLMAP": ["/usr/local/bin/OpenMVS/InterfaceCOLMAP", "/usr/local/OpenMVS/bin/InterfaceCOLMAP", "/opt/OpenMVS/bin/InterfaceCOLMAP"],
        "DensifyPointCloud": ["/usr/local/bin/OpenMVS/DensifyPointCloud", "/usr/local/OpenMVS/bin/DensifyPointCloud", "/opt/OpenMVS/bin/DensifyPointCloud"],
        "ReconstructMesh": ["/usr/local/bin/OpenMVS/ReconstructMesh", "/usr/local/OpenMVS/bin/ReconstructMesh", "/opt/OpenMVS/bin/ReconstructMesh"],
        "PoissonRecon": ["/usr/local/bin/OpenMVS/PoissonRecon", "/usr/local/OpenMVS/bin/PoissonRecon", "/opt/OpenMVS/bin/PoissonRecon"],
    }.get(name, [])
    for candidate in (name, *alternatives, *explicit):
        found = shutil.which(candidate) if "/" not in candidate else (candidate if os.access(candidate, os.X_OK) else None)
        if found:
            return found
    return None


def completion_command():
    global_command = command("aerotrace-complete", "aerotrace-complete.exe")
    if global_command:
        return [global_command]
    local = Path.cwd() / "tools" / "aerotrace-complete"
    if local.exists():
        return [sys.executable, str(local)]
    return None


def fail(out, stage, message, job_id, tools, code=2):
    emit(out, stage, "error", message, capabilities=tools)
    (out / "report.json").write_text(json.dumps({"status": "error", "jobId": job_id, "failed_stage": stage, "tools": tools}, indent=2), encoding="utf-8")
    return code


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", required=True)
    ap.add_argument("--output", required=True)
    ap.add_argument("--job-id", required=True)
    args = ap.parse_args()
    source = Path(args.input).resolve()
    out = Path(args.output).resolve()
    out.mkdir(parents=True, exist_ok=True)
    workspace = out / "workspace"
    workspace.mkdir(exist_ok=True)
    images = workspace / "images"
    images.mkdir(exist_ok=True)
    log = out / "pipeline.log"
    if os.name != "nt":
        os.environ["PATH"] = os.pathsep.join(["/usr/local/bin/OpenMVS", "/usr/local/OpenMVS/bin", "/opt/OpenMVS/bin", os.environ.get("PATH", "")])

    tools = {
        "python3": command("python3", "python"),
        "ffmpeg": command("ffmpeg"),
        "colmap": command("colmap", "colmap.exe"),
        "InterfaceCOLMAP": command("InterfaceCOLMAP", "InterfaceCOLMAP.exe"),
        "DensifyPointCloud": command("DensifyPointCloud", "DensifyPointCloud.exe"),
        "ReconstructMesh": command("ReconstructMesh", "ReconstructMesh.exe"),
        "PoissonRecon": command("PoissonRecon", "PoissonRecon.exe"),
        "nvidia-smi": command("nvidia-smi", "nvidia-smi.exe"),
        "aerotrace-complete": completion_command()[0] if completion_command() else None,
    }
    (out / "capabilities.json").write_text(json.dumps({"jobId": args.job_id, "tools": tools}, indent=2), encoding="utf-8")

    if not tools["python3"]:
        return fail(out, "segmentation", "Python runtime is unavailable.", args.job_id, tools)

    emit(out, "segmentation", "processing", "Preparing source frames; fallback masks are marked partial.")
    mask = workspace / "object-mask.json"
    mask.write_text(json.dumps({"type": "confidence-mask", "source": "center-prior-fallback", "confidence": "partial", "note": "Configure SAM/SAM2 for production masking of traffic and fountain water."}), encoding="utf-8")

    if source.suffix.lower() in {".mp4", ".mov", ".webm", ".mkv"}:
        if not tools["ffmpeg"]:
            return fail(out, "segmentation", "ffmpeg is required to extract frames from video.", args.job_id, tools)
        emit(out, "segmentation", "processing", "Extracting sharp-overlap video frames with ffmpeg.")
        rc = run([tools["ffmpeg"], "-y", "-i", source, "-vf", "fps=3,scale=1920:-2", "-q:v", "2", images / "%06d.jpg"], workspace, log)
        if rc != 0:
            return fail(out, "segmentation", "Video frame extraction failed; inspect pipeline.log.", args.job_id, tools, rc)
    else:
        shutil.copy2(source, images / source.name)

    required = ["colmap", "InterfaceCOLMAP", "DensifyPointCloud", "ReconstructMesh"]
    missing = [name for name in required if not tools[name]]
    if missing:
        emit(out, "colmap", "awaiting_gpu", "Native tools are missing; no mesh was fabricated.", missing=missing)
        emit(out, "mvs", "awaiting_gpu", "Dense MVS waits for COLMAP and OpenMVS outputs.")
        emit(out, "poisson", "awaiting_gpu", "Surface reconstruction waits for a dense point cloud.")
        emit(out, "completion", "partial", "Completion waits for an observed mesh.", observed_only=True)
        emit(out, "export", "partial", "Only frame and capability metadata were produced.")
        (out / "report.json").write_text(json.dumps({"status": "awaiting_gpu", "partial": True, "jobId": args.job_id, "tools": tools, "missing": missing}, indent=2), encoding="utf-8")
        return 0

    database = workspace / "database.db"
    emit(out, "colmap", "processing", "Extracting COLMAP features from sampled frames.")
    rc = run([tools["colmap"], "feature_extractor", "--database_path", database, "--image_path", images, "--ImageReader.single_camera", "1"], workspace, log)
    if rc != 0:
        return fail(out, "colmap", "COLMAP feature extraction failed; inspect pipeline.log.", args.job_id, tools, rc)

    emit(out, "colmap", "processing", "Matching features across the orbit frames.")
    matcher = "sequential_matcher" if source.suffix.lower() in {".mp4", ".mov", ".webm", ".mkv"} else "exhaustive_matcher"
    rc = run([tools["colmap"], matcher, "--database_path", database], workspace, log)
    if rc != 0:
        return fail(out, "colmap", "COLMAP feature matching failed; inspect pipeline.log.", args.job_id, tools, rc)

    sparse = workspace / "sparse"
    sparse.mkdir(exist_ok=True)
    emit(out, "colmap", "processing", "Estimating camera poses with COLMAP mapper.")
    rc = run([tools["colmap"], "mapper", "--database_path", database, "--image_path", images, "--output_path", sparse], workspace, log)
    if rc != 0:
        return fail(out, "colmap", "COLMAP mapper failed; inspect pipeline.log.", args.job_id, tools, rc)

    model = next((path for path in sorted(sparse.iterdir()) if path.is_dir()), None)
    if not model:
        return fail(out, "colmap", "COLMAP produced no sparse camera model. Improve frame overlap or masking.", args.job_id, tools)

    undistorted = workspace / "dense"
    emit(out, "mvs", "processing", "Undistorting images for OpenMVS.")
    rc = run([tools["colmap"], "image_undistorter", "--image_path", images, "--input_path", model, "--output_path", undistorted, "--output_type", "COLMAP"], workspace, log)
    if rc != 0:
        return fail(out, "mvs", "COLMAP image undistortion failed; inspect pipeline.log.", args.job_id, tools, rc)

    scene = workspace / "scene.mvs"
    emit(out, "mvs", "processing", "Converting COLMAP poses to an OpenMVS scene.")
    rc = run([tools["InterfaceCOLMAP"], "-i", undistorted, "-o", scene, "--image-folder", undistorted / "images"], workspace, log)
    if rc != 0:
        return fail(out, "mvs", "OpenMVS InterfaceCOLMAP failed; inspect pipeline.log.", args.job_id, tools, rc)

    emit(out, "mvs", "processing", "Running OpenMVS dense multi-view stereo.")
    rc = run([tools["DensifyPointCloud"], scene, "--resolution-level", "1", "--number-views", "8"], workspace, log)
    if rc != 0:
        return fail(out, "mvs", "OpenMVS DensifyPointCloud failed; inspect pipeline.log.", args.job_id, tools, rc)

    emit(out, "poisson", "processing", "Reconstructing the observed surface with OpenMVS mesh reconstruction.")
    dense_scene = workspace / "scene_dense.mvs"
    rc = run([tools["ReconstructMesh"], dense_scene if dense_scene.exists() else scene], workspace, log)
    if rc != 0:
        return fail(out, "poisson", "OpenMVS ReconstructMesh failed; inspect pipeline.log.", args.job_id, tools, rc)

    observed_mesh = next((candidate for candidate in [workspace / "scene_dense_mesh.ply", workspace / "scene_dense_mesh.obj", workspace / "scene_mesh.ply", workspace / "scene_mesh.obj"] if candidate.exists()), None)
    if not observed_mesh:
        return fail(out, "poisson", "Native reconstruction produced no mesh file. Inspect pipeline.log and OpenMVS output names.", args.job_id, tools)

    completed_mesh = out / "completed-mesh.ply"
    completion_report = out / "completion-report.json"
    completion = completion_command()
    if completion:
        emit(out, "completion", "processing", "Completing the observed mesh and writing provenance metadata.")
        rc = run(completion + ["--input", observed_mesh, "--output", completed_mesh, "--report", completion_report], workspace, log)
        if rc == 0 and completed_mesh.exists():
            emit(out, "completion", "complete", "Completion worker finished; generated surfaces are marked as inferred.", provenance=str(completion_report))
        else:
            return fail(out, "completion", "Completion worker failed; inspect pipeline.log and completion-report.json.", args.job_id, tools, rc)
    else:
        emit(out, "completion", "partial", "Completion worker unavailable; observed mesh remains authoritative.", observed_only=True)

    emit(out, "export", "complete", "Native reconstruction and completion artifacts were written to the job directory.", observed_mesh=str(observed_mesh), completed_mesh=str(completed_mesh) if completed_mesh.exists() else None)
    (out / "report.json").write_text(json.dumps({"status": "complete" if completed_mesh.exists() else "partial", "jobId": args.job_id, "tools": tools, "observed_mesh": str(observed_mesh), "completed_mesh": str(completed_mesh) if completed_mesh.exists() else None, "completion_report": str(completion_report) if completion_report.exists() else None}, indent=2), encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main())
