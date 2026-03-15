import { useState } from "react";
import { ChevronRight, ChevronDown, Folder, FolderOpen, File } from "lucide-react";
import { cn } from "@/lib/utils";
import type { FileEntry } from "@shared/types";

interface FileTreeProps {
  entries: FileEntry[];
  workspaceId: string;
  selectedPath: string | null;
  onSelect: (path: string) => void;
  onLoadDir?: (path: string) => Promise<FileEntry[]>;
}

interface TreeNode {
  entry: FileEntry;
  children?: TreeNode[];
  isOpen: boolean;
  isLoaded: boolean;
}

function buildTree(entries: FileEntry[]): TreeNode[] {
  return entries.map((entry) => ({
    entry,
    children: entry.type === "directory" ? [] : undefined,
    isOpen: false,
    isLoaded: false,
  }));
}

interface NodeProps {
  node: TreeNode;
  depth: number;
  selectedPath: string | null;
  onSelect: (path: string) => void;
  onToggle: (path: string) => void;
}

function TreeNode({ node, depth, selectedPath, onSelect, onToggle }: NodeProps) {
  const isDir = node.entry.type === "directory";
  const isSelected = selectedPath === node.entry.path;

  const handleClick = () => {
    if (isDir) {
      onToggle(node.entry.path);
    } else {
      onSelect(node.entry.path);
    }
  };

  return (
    <div>
      <div
        className={cn(
          "flex items-center gap-1.5 px-2 py-1 text-xs cursor-pointer rounded-sm transition-colors",
          isSelected
            ? "bg-primary/15 text-primary"
            : "hover:bg-muted/50 text-foreground",
        )}
        style={{ paddingLeft: `${depth * 12 + 8}px` }}
        onClick={handleClick}
      >
        {isDir ? (
          <>
            <span className="text-muted-foreground w-3 h-3 flex-shrink-0">
              {node.isOpen ? (
                <ChevronDown className="h-3 w-3" />
              ) : (
                <ChevronRight className="h-3 w-3" />
              )}
            </span>
            {node.isOpen ? (
              <FolderOpen className="h-3.5 w-3.5 text-amber-400 flex-shrink-0" />
            ) : (
              <Folder className="h-3.5 w-3.5 text-amber-400 flex-shrink-0" />
            )}
          </>
        ) : (
          <>
            <span className="w-3 flex-shrink-0" />
            <File className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0" />
          </>
        )}
        <span className="truncate">{node.entry.name}</span>
      </div>

      {isDir && node.isOpen && node.children && (
        <div>
          {node.children.map((child) => (
            <TreeNode
              key={child.entry.path}
              node={child}
              depth={depth + 1}
              selectedPath={selectedPath}
              onSelect={onSelect}
              onToggle={onToggle}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export function FileTree({ entries, workspaceId, selectedPath, onSelect, onLoadDir }: FileTreeProps) {
  const [nodes, setNodes] = useState<TreeNode[]>(() => buildTree(entries));

  const handleToggle = async (path: string) => {
    setNodes((prev) => toggleNode(prev, path));

    if (onLoadDir) {
      const node = findNode(nodes, path);
      if (node && !node.isLoaded) {
        const children = await onLoadDir(path);
        setNodes((prev) => setChildren(prev, path, buildTree(children)));
      }
    }
  };

  // Re-sync when entries change
  if (nodes.length === 0 && entries.length > 0) {
    setNodes(buildTree(entries));
  }

  return (
    <div className="select-none">
      {nodes.map((node) => (
        <TreeNode
          key={node.entry.path}
          node={node}
          depth={0}
          selectedPath={selectedPath}
          onSelect={onSelect}
          onToggle={handleToggle}
        />
      ))}
      {nodes.length === 0 && (
        <p className="text-xs text-muted-foreground px-3 py-4">No files found</p>
      )}
    </div>
  );
}

function findNode(nodes: TreeNode[], path: string): TreeNode | null {
  for (const node of nodes) {
    if (node.entry.path === path) return node;
    if (node.children) {
      const found = findNode(node.children, path);
      if (found) return found;
    }
  }
  return null;
}

function toggleNode(nodes: TreeNode[], path: string): TreeNode[] {
  return nodes.map((node) => {
    if (node.entry.path === path) {
      return { ...node, isOpen: !node.isOpen };
    }
    if (node.children) {
      return { ...node, children: toggleNode(node.children, path) };
    }
    return node;
  });
}

function setChildren(nodes: TreeNode[], path: string, children: TreeNode[]): TreeNode[] {
  return nodes.map((node) => {
    if (node.entry.path === path) {
      return { ...node, children, isLoaded: true };
    }
    if (node.children) {
      return { ...node, children: setChildren(node.children, path, children) };
    }
    return node;
  });
}
