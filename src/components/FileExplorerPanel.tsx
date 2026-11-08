import * as import_react from "react";
import * as import_jsx_runtime from "react/jsx-runtime";
import { FileText, Folder, FolderOpen, HardDrive, Plus, Save, Trash2, X } from "lucide-react";

// src/components/FileExplorerPanel.tsx
var STORAGE_KEY = "dored_app_folder_files_v1";
var DEFAULT_APP_FILES = [{
	id: "sample-flange-01",
	name: "Part_01_SteppedBlock.dored.json",
	updatedAt: "2026-11-06 10:00",
	source: "app",
	entities: [
		{
			id: "sf-1",
			view: "front",
			type: "rect",
			lineType: "thick_solid",
			x: 24,
			y: 20,
			width: 72,
			height: 44,
			source: "user"
		},
		{
			id: "sf-2",
			view: "top",
			type: "rect",
			lineType: "thick_solid",
			x: 24,
			y: 32,
			width: 72,
			height: 52,
			source: "user"
		},
		{
			id: "sf-3",
			view: "top",
			type: "circle",
			lineType: "thick_solid",
			center: {
				u: 60,
				v: 58
			},
			radius: 12,
			source: "user"
		}
	]
}];
export const FileExplorerPanel: any = ({ isOpen, onClose, dict, currentEntities, onLoadEntities, onNewBlank }) => {
	const [folderMode, setFolderMode] = (0, import_react.useState)("app");
	const [appFiles, setAppFiles] = (0, import_react.useState)(() => {
		try {
			const raw = localStorage.getItem(STORAGE_KEY);
			if (raw) {
				const parsed = JSON.parse(raw);
				if (Array.isArray(parsed) && parsed.length > 0) return parsed;
			}
		} catch {}
		return DEFAULT_APP_FILES;
	});
	const [diskFiles, setDiskFiles] = (0, import_react.useState)([]);
	const [mountedDirName, setMountedDirName] = (0, import_react.useState)("");
	const [dirHandleRef, setDirHandleRef] = (0, import_react.useState)(null);
	const [fileNameInput, setFileNameInput] = (0, import_react.useState)("Untitled_01");
	const [activeFileId, setActiveFileId] = (0, import_react.useState)("");
	const fallbackDirInputRef = (0, import_react.useRef)(null);
	(0, import_react.useEffect)(() => {
		try {
			localStorage.setItem(STORAGE_KEY, JSON.stringify(appFiles));
		} catch {}
	}, [appFiles]);
	if (!isOpen) return null;
	const handleMountLocalDirectory = async () => {
		const win: any = window;
		if (typeof win.showDirectoryPicker === "function") try {
			const handle = await win.showDirectoryPicker({ mode: "readwrite" });
			setDirHandleRef(handle);
			setMountedDirName(handle.name || "LocalDisk");
			const loaded = [];
			for await (const entry of handle.values()) if (entry.kind === "file" && entry.name.endsWith(".json")) {
				const file = await entry.getFile();
				const text = await file.text();
				try {
					const parsed = JSON.parse(text);
					if (Array.isArray(parsed.entities)) loaded.push({
						id: `disk-${entry.name}`,
						name: entry.name,
						updatedAt: new Date(file.lastModified).toLocaleTimeString([], {
							hour: "2-digit",
							minute: "2-digit"
						}),
						entities: parsed.entities,
						source: "disk",
						fileHandle: entry
					});
				} catch {}
			}
			setDiskFiles(loaded);
			setFolderMode("disk");
			return;
		} catch {}
		fallbackDirInputRef.current?.click();
	};
	const handleFallbackDirectorySelect = async (e) => {
		const files = e.target.files;
		if (!files || files.length === 0) return;
		const loaded = [];
		let folderName = "LocalDisk";
		for (let i = 0; i < files.length; i++) {
			const f = files[i];
			const rel = f.webkitRelativePath || "";
			if (rel && folderName === "LocalDisk") folderName = rel.split("/")[0] || "LocalDisk";
			if (f.name.endsWith(".json")) try {
				const text = await f.text();
				const parsed = JSON.parse(text);
				if (Array.isArray(parsed.entities)) loaded.push({
					id: `disk-${f.name}-${i}`,
					name: f.name,
					updatedAt: new Date(f.lastModified).toLocaleDateString(),
					entities: parsed.entities,
					source: "disk"
				});
			} catch {}
		}
		setMountedDirName(folderName);
		setDiskFiles(loaded);
		setFolderMode("disk");
	};
	const handleSaveCurrentFile = async () => {
		const cleanName = (fileNameInput.trim() || "Untitled").replace(/\.json$/i, "") + ".json";
		const nowStr = (/* @__PURE__ */ new Date()).toLocaleTimeString([], {
			hour: "2-digit",
			minute: "2-digit"
		});
		if (folderMode === "disk") {
			if (dirHandleRef) try {
				const writable = await (await dirHandleRef.getFileHandle(cleanName, { create: true })).createWritable();
				await writable.write(JSON.stringify({
					name: cleanName,
					updatedAt: nowStr,
					entities: currentEntities
				}, null, 2));
				await writable.close();
			} catch {}
			const nextFile = {
				id: `disk-${cleanName}`,
				name: cleanName,
				updatedAt: nowStr,
				entities: currentEntities,
				source: "disk"
			};
			setDiskFiles((prev) => {
				const filtered = prev.filter((item) => item.name !== cleanName);
				return [nextFile, ...filtered];
			});
			setActiveFileId(nextFile.id);
		} else {
			const nextFile = {
				id: `app-${cleanName}`,
				name: cleanName,
				updatedAt: nowStr,
				entities: currentEntities,
				source: "app"
			};
			setAppFiles((prev) => {
				const filtered = prev.filter((item) => item.name !== cleanName);
				return [nextFile, ...filtered];
			});
			setActiveFileId(nextFile.id);
		}
	};
	const handleDeleteFile = (id, e) => {
		e.stopPropagation();
		if (folderMode === "app") setAppFiles((prev) => prev.filter((f) => f.id !== id));
		else setDiskFiles((prev) => prev.filter((f) => f.id !== id));
	};
	const displayedFiles = folderMode === "app" ? appFiles : diskFiles;
	return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("aside", {
		className: "w-56 bg-[#0D131F] border-r border-[#263244] flex flex-col h-full shrink-0 select-none",
		children: [
			/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
				className: "flex items-center justify-between px-3 py-2.5 border-b border-[#263244]",
				children: [/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
					className: "flex items-center gap-1.5 text-xs font-semibold text-white",
					children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)(FolderOpen, { className: "w-3.5 h-3.5 text-[#38BDF8]" }), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { children: dict.title })]
				}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", {
					onClick: onClose,
					className: "p-1 rounded text-[#94A3B8] hover:text-white hover:bg-[#1E293B]",
					children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(X, { className: "w-3.5 h-3.5" })
				})]
			}),
			/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
				className: "p-2 border-b border-[#263244] space-y-2",
				children: [/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
					className: "grid grid-cols-2 gap-1 p-0.5 bg-[#0B0F17] rounded border border-[#1E293B] text-[11px]",
					children: [/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("button", {
						onClick: () => setFolderMode("app"),
						className: `py-1 rounded font-medium flex items-center justify-center gap-1 transition-colors ${folderMode === "app" ? "bg-[#1E293B] text-white" : "text-[#94A3B8] hover:text-white"}`,
						children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Folder, { className: "w-3 h-3 text-[#38BDF8]" }), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { children: dict.appFolder })]
					}), /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("button", {
						onClick: () => setFolderMode("disk"),
						className: `py-1 rounded font-medium flex items-center justify-center gap-1 transition-colors ${folderMode === "disk" ? "bg-[#1E293B] text-white" : "text-[#94A3B8] hover:text-white"}`,
						children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)(HardDrive, { className: "w-3 h-3 text-[#10B981]" }), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { children: dict.localFolder })]
					})]
				}), folderMode === "disk" && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { children: [
					/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("button", {
						onClick: handleMountLocalDirectory,
						className: "w-full py-1.5 px-2.5 rounded bg-[#161F2E] hover:bg-[#1E293B] border border-[#263244] text-[11px] font-medium text-[#10B981] flex items-center justify-center gap-1.5 transition-colors",
						children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)(HardDrive, { className: "w-3 h-3" }), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { children: dict.mountDiskFolder })]
					}),
					/* @__PURE__ */ (0, import_jsx_runtime.jsx)("input", {
						ref: fallbackDirInputRef,
						type: "file",
						webkitdirectory: "true",
						multiple: true,
						onChange: handleFallbackDirectorySelect,
						className: "hidden"
					}),
					mountedDirName && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
						className: "mt-1 px-1 text-[10px] font-mono text-[#94A3B8] truncate",
						children: [dict.mountedLabel, /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", {
							className: "text-[#E2E8F0]",
							children: mountedDirName
						})]
					})
				] })]
			}),
			/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
				className: "p-2 border-b border-[#263244] space-y-1.5",
				children: [/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("button", {
					onClick: () => {
						onNewBlank();
						setFileNameInput(`Drawing_${displayedFiles.length + 1}`);
					},
					className: "w-full py-1.5 px-2.5 rounded bg-[#161F2E] hover:bg-[#1E293B] border border-[#263244] text-xs font-medium text-[#E2E8F0] flex items-center justify-center gap-1.5 transition-colors",
					children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Plus, { className: "w-3.5 h-3.5 text-[#38BDF8]" }), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { children: dict.newDrawing })]
				}), /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
					className: "flex items-center gap-1",
					children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("input", {
						type: "text",
						value: fileNameInput,
						onChange: (e) => setFileNameInput(e.target.value),
						placeholder: dict.fileNamePlaceholder,
						className: "flex-1 min-w-0 bg-[#0B0F17] border border-[#263244] rounded px-2 py-1 text-xs text-white font-mono focus:outline-none focus:border-[#38BDF8]"
					}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", {
						onClick: handleSaveCurrentFile,
						className: "px-2.5 py-1 rounded bg-[#0284C7] hover:bg-[#0369A1] text-xs font-medium text-white flex items-center gap-1 shrink-0",
						title: dict.saveCurrent,
						children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Save, { className: "w-3.5 h-3.5" })
					})]
				})]
			}),
			/* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
				className: "flex-1 overflow-y-auto p-2 space-y-1",
				children: displayedFiles.length === 0 ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
					className: "py-8 text-center text-xs text-[#64748B]",
					children: dict.emptyFolder
				}) : displayedFiles.map((file) => {
					const active = file.id === activeFileId;
					return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
						onClick: () => {
							setActiveFileId(file.id);
							setFileNameInput(file.name.replace(/\.json$/i, ""));
							onLoadEntities(file.entities, file.name);
						},
						className: `group px-2.5 py-2 rounded border cursor-pointer flex items-center justify-between gap-2 transition-colors ${active ? "bg-[#16273B] border-[#38BDF8] text-white" : "bg-[#111827] border-[#1E293B] text-[#CBD5E1] hover:bg-[#161F2E]"}`,
						children: [/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
							className: "flex items-center gap-2 min-w-0",
							children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)(FileText, { className: "w-3.5 h-3.5 text-[#38BDF8] shrink-0" }), /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
								className: "min-w-0",
								children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
									className: "text-xs font-medium truncate",
									children: file.name
								}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
									className: "text-[10px] font-mono text-[#64748B]",
									children: file.updatedAt
								})]
							})]
						}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", {
							onClick: (e) => handleDeleteFile(file.id, e),
							className: "opacity-0 group-hover:opacity-100 p-1 rounded text-[#64748B] hover:text-[#EF4444] transition-opacity",
							children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Trash2, { className: "w-3 h-3" })
						})]
					}, file.id);
				})
			})
		]
	});
};
