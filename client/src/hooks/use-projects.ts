import { useContext } from "react";
import { ProjectContext } from "@/contexts/ProjectContext";

export function useProjects() {
  const ctx = useContext(ProjectContext);
  if (!ctx) {
    throw new Error("useProjects must be used inside ProjectProvider");
  }
  return ctx;
}
