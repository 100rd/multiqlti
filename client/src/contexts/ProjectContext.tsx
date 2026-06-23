import { createContext, useState, useEffect, useCallback, ReactNode } from "react";
import { apiRequest } from "@/lib/queryClient";
import type { Project } from "@shared/schema";

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
        setCurrentProject(data.find(p => p.id === savedProjectId) || null);
      } else if (data.length > 0) {
        // Auto select first project
        setCurrentProject(data[0]);
        localStorage.setItem("project_id", data[0].id);
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
      // Reload the page or invalidate queries
      window.location.reload(); // Hard reload is easiest way to wipe old query cache
    }
  }, [projects]);

  return (
    <ProjectContext.Provider value={{ projects, currentProject, isLoadingProjects, selectProject, refreshProjects: fetchProjects }}>
      {children}
    </ProjectContext.Provider>
  );
}
