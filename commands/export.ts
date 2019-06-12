import fs = require("fs");
import path = require("path");
import * as vscode from "vscode";
import { AtelierAPI } from "../api";
import { ClassNode } from "../explorer/models/classesNode";
import { PackageNode } from "../explorer/models/packageNode";
import { RootNode } from "../explorer/models/rootNode";
import { RoutineNode } from "../explorer/models/routineNode";
import { config } from "../extension";
import { mkdirSyncRecursive, notNull, outputChannel, workspaceFolderUri } from "../utils";

const filesFilter = (file: any) => {
  if (file.cat === "CSP" || file.name.startsWith("%") || file.name.startsWith("INFORMATION.")) {
    return false;
  }
  return true;
};

export const getFileName = (folder: string, name: string, split: boolean, addCategory: boolean): string => {
  const fileNameArray: string[] = name.split(".");
  const fileExt = fileNameArray.pop().toLowerCase();
  const cat = (typeof addCategory === "object" && addCategory[fileExt]) ?
    addCategory[fileExt] : (addCategory)
      ? fileExt === "cls"
        ? "CLS"
        : ["int", "mac", "inc"].includes(fileExt)
          ? "RTN"
          : "OTH"
      : null;
  if (split) {
    const fileName = [folder, cat, ...fileNameArray].filter(notNull).join(path.sep);
    return [fileName, fileExt].join(".");
  }
  return [folder, cat, name].filter(notNull).join(path.sep);
};

export async function exportFile(workspaceFolder: string, name: string, fileName: string): Promise<void> {
  if (!config("conn", workspaceFolder).active) {
    return Promise.reject("Connection not active");
  }
  const api = new AtelierAPI(workspaceFolder);
  const log = (status) => outputChannel.appendLine(`export "${name}" as "${fileName}" - ${status}`);
  const folders = path.dirname(fileName);
  return mkdirSyncRecursive(folders)
    .then(() => {
      return api.getDoc(name).then((data) => {
        if (!data || !data.result) {
          throw new Error("Something wrong happened");
        }
        const content = data.result.content;
        const { noStorage, dontExportIfNoChanges } = config("export");

        const promise = new Promise((resolve, reject) => {
          if (noStorage) {
            // get only the storage xml for the doc.
            api.getDoc(name + "?storageOnly=1").then((storageData) => {
              if (!storageData || !storageData.result) {
                reject(new Error("Something wrong happened fetching the storage data"));
              }
              const storageContent = storageData.result.content;

              if (storageContent.length > 1 && storageContent[0] && storageContent.length < content.length) {
                const storageContentString = storageContent.join("\n");
                const contentString = content.join("\n");

                // find and replace the docs storage section with ''
                resolve({
                  content: contentString.replace(storageContentString, ""),
                  found: contentString.indexOf(storageContentString) >= 0,
                });
              } else {
                resolve({ found: false });
              }
            });
          } else {
            resolve({ found: false });
          }
        });

        return promise
          .then((res: any) => {
            let joinedContent = (content || []).join("\n").toString("utf8");
            let isSkipped = "";

            if (res.found) {
              joinedContent = res.content.toString("utf8");
            }

            if (dontExportIfNoChanges && fs.existsSync(fileName)) {
              const existingContent = fs.readFileSync(fileName, "utf8");
              // stringify to harmonise the text encoding.
              if (JSON.stringify(joinedContent) !== JSON.stringify(existingContent)) {
                fs.writeFileSync(fileName, joinedContent);
              } else {
                isSkipped = " => skipped - no changes.";
              }
            } else {
              fs.writeFileSync(fileName, joinedContent);
            }

            log(`Success ${isSkipped}`);
          })
          .catch((error) => {
            throw error;
          });
      });
    })
    .catch((error) => {
      log("ERROR: " + error);
      throw error;
    });
}

export async function exportList(files: string[], workspaceFolder: string): Promise<any> {
  if (!files || !files.length) {
    vscode.window.showWarningMessage("Nothing to export");
  }
  const { atelier, folder, addCategory } = config("export", workspaceFolder);

  const root = [workspaceFolderUri(workspaceFolder).fsPath, folder].join(path.sep);
  const run = async (fileList) => {
    const errors = [];
    for (const file of fileList) {
      await exportFile(workspaceFolder, file, getFileName(root, file, atelier, addCategory))
        .catch((error) => { errors.push(`${file} - ${error}`); });
    }
    outputChannel.appendLine(`Exported items: ${fileList.length - errors.length}`);
    if (errors.length) {
      outputChannel.appendLine(`Items failed to export: \n${errors.join("\n")}`);
    }
  };
  return run(files);
}

export async function exportAll(workspaceFolder?: string): Promise<any> {
  if (!workspaceFolder) {
    const list = vscode.workspace.workspaceFolders
      .filter((folder) => config("conn", folder.name).active)
      .map((el) => el.name);
    if (list.length > 1) {
      return vscode.window.showQuickPick(list)
        .then((folder) => folder ? exportAll : null);
    } else {
      workspaceFolder = list.pop();
    }
  }
  if (!config("conn", workspaceFolder).active) {
    return;
  }
  const api = new AtelierAPI();
  api.setConnection(workspaceFolder);
  outputChannel.show(true);
  const { category, generated, filter } = config("export", workspaceFolder);
  const files = (data) => data.result.content.filter(filesFilter).map((file) => file.name);
  return api.getDocNames({ category, generated, filter }).then((data) => {
    return exportList(files(data), workspaceFolder);
  });
}

export async function exportExplorerItem(node: RootNode | PackageNode | ClassNode | RoutineNode): Promise<any> {
  if (!config("conn", node.workspaceFolder).active) {
    return;
  }
  const workspaceFolder = node.workspaceFolder;
  const nodesList = node instanceof RootNode ? node.getChildren(node) : Promise.resolve([node]);
  return nodesList
    .then((nodes) =>
      nodes.reduce(
        (list, subNode) => list.concat(subNode instanceof PackageNode ? subNode.getClasses() : [subNode.fullName]),
        [],
      ),
    )
    .then((items) => {
      return exportList(items, workspaceFolder);
    });
}
