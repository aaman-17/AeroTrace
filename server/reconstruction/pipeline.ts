import { execFile, spawn } from "node:child_process";
import { access, mkdir } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";

export type PipelineStage = "segmentation" | "colmap" | "mvs" | "poisson" | "completion" | "export";
export type PipelineCapabilities = Record<PipelineStage, boolean> & { gpu: boolean; ready: boolean };

const commandExists = (command: string) => new Promise<boolean>((resolve) => {
  const isWindows = process.platform === "win32";
  const executable = isWindows ? "where.exe" : "sh";
  const args = isWindows ? [command] : ["-lc", `command -v ${command}`];
  execFile(executable, args, { windowsHide: true }, (error) => resolve(!error));
});

const commandExistsAny = async (commands: string[], explicitPaths: string[] = []) => {
  for (const candidate of explicitPaths) {
    try { await access(candidate, constants.X_OK); return true; } catch {}
  }
  for (const command of commands) {
    if (await commandExists(command)) return true;
  }
  return false;
};

const openMvsCandidates = (name: string) => process.platform === "win32"
  ? [`C:\\Program Files\\OpenMVS\\${name}.exe`, `C:\\Tools\\OpenMVS\\${name}.exe`]
  : [`/usr/local/bin/OpenMVS/${name}`, `/usr/local/OpenMVS/bin/${name}`, `/opt/OpenMVS/bin/${name}`];

const localCompletionReady = async () => {
  const script = path.resolve(process.cwd(), "tools/aerotrace-complete");
  try { await access(script, constants.R_OK); } catch { return false; }
  return new Promise<boolean>((resolve) => {
    const python = process.platform === "win32" ? "python" : "python3";
    execFile(python, ["-c", "import open3d, numpy; print('ready')"], { windowsHide: true }, (error) => resolve(!error));
  });
};

export async function detectPipelineCapabilities(): Promise<PipelineCapabilities> {
  const [segmenter, colmap, interfaceColmap, densify, poisson, globalCompletion, localCompletion, gpu] = await Promise.all([
    commandExistsAny(["python3", "python"]),
    commandExistsAny(["colmap", "colmap.exe"]),
    commandExistsAny(["InterfaceCOLMAP", "InterfaceCOLMAP.exe"], openMvsCandidates("InterfaceCOLMAP")),
    commandExistsAny(["DensifyPointCloud", "DensifyPointCloud.exe"], openMvsCandidates("DensifyPointCloud")),
    commandExistsAny(["PoissonRecon", "PoissonRecon.exe"], openMvsCandidates("PoissonRecon")),
    commandExistsAny(["aerotrace-complete", "aerotrace-complete.exe"]),
    localCompletionReady(),
    commandExistsAny(["nvidia-smi", "nvidia-smi.exe"]),
  ]);
  const mvs = interfaceColmap && densify;
  const completion = globalCompletion || localCompletion;
  return { segmentation: segmenter, colmap, mvs, poisson, completion, export: mvs || poisson, gpu, ready: Boolean(colmap && mvs && poisson), };
}

export async function launchReconstructionWorker(input: { sourcePath: string; outputDir: string; jobId: number; }) {
  await mkdir(input.outputDir, { recursive: true });
  const worker = path.resolve(process.cwd(), "server/reconstruction/worker.py");
  const extraPath = process.platform === "win32" ? [] : ["/usr/local/bin/OpenMVS", "/usr/local/OpenMVS/bin", "/opt/OpenMVS/bin"];
  const env = { ...process.env, PATH: [...extraPath, process.env.PATH ?? ""].filter(Boolean).join(path.delimiter) };
  return spawn(process.platform === "win32" ? "python" : "python3", [worker, "--input", input.sourcePath, "--output", input.outputDir, "--job-id", String(input.jobId)], { detached: true, stdio: "ignore", env }).unref();
}

export async function pathIsReadable(filePath: string) {
  try { await access(filePath, constants.R_OK); return true; } catch { return false; }
}
