export interface Task {
  id?: string;
  type?: "bug" | "improvement" | "feature" | string;
  title?: string;
  desc?: string;
  source?: string;
  created?: string | number | Date;
  priority?: number;
}

