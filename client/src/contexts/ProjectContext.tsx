import { createContext, useState, useEffect, useCallback, ReactNode } from "react";
import { apiRequest, queryClient } from "@/lib/queryClient";
import type { Project } from "@shared/schema";

const SENTINEL_ID = "__default__";

interface ProjectContextValue {
  projects: Project[];
  currentProject: Project | null;
  isLoadingProjects: boolean;
  selectProject: (projectId: string) => void;
  refreshProjects: () => Promise<void>;
}

export const ProjectContext = createContext<ProjectContextValue | null>(null);

export function ProjectProvider({ children }: { children: ReactNode }) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [currentProject, setCurrentProject] = useState<Project | null>(null);
  const [isLoadingProjects, setIsLoadingProjects] = useState(true);

  const fetchProjects = useCallback(async () => {
    try {
      const res = await apiRequest("GET", "/api/projects");
      const data = await res.json() as Project[];
      setProjects(data);

      const savedProjectId = localStorage.getItem("project_id");
      if (savedProjectId && data.find(p => p.id === savedProjectId)) {
        // Respect explicitly saved preference (even if it's __default__)
        setCurrentProject(data.find(p => p.id === savedProjectId) || null);
      } else if (data.length > 0) {
        // Auto-select: prefer non-sentinel projects
        const realProjects = data.filter(p => p.id !== SENTINEL_ID);
        const autoSelect = realProjects.length > 0 ? realProjects[0] : data[0];
        setCurrentProject(autoSelect);
        localStorage.setItem("project_id", autoSelect.id);
      }
    } catch (e) {
      console.error("Failed to fetch projects", e);
    } finally {
      setIsLoadingProjects(false);
    }
  }, []);

  useEffect(() => {
    // Only fetch if auth token exists
    const token = localStorage.getItem("auth_token");
    if (token) {
      fetchProjects();
    } else {
      setIsLoadingProjects(false);
    }
  }, [fetchProjects]);

  const selectProject = useCallback((projectId: string) => {
    const p = projects.find(p => p.id === projectId);
    if (p) {
      setCurrentProject(p);
      localStorage.setItem("project_id", projectId);
      // Invalidate all cached queries so every scoped screen refetches
      // with the new x-project-id that queryClient picks from localStorage.
      void queryClient.invalidateQueries();
    }
  }, [projects]);

  return (
    <ProjectContext.Provider value={{ projects, currentProject, isLoadingProjects, selectProject, refreshProjects: fetchProjects }}>
      {children}
    </ProjectContext.Provider>
  );
}
