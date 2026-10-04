import { createBrowserRouter, RouterProvider } from "react-router-dom";
import { Shell } from "./components/Shell";
import Overview from "./pages/Overview";
import Envs from "./pages/Envs";
import Flows from "./pages/Flows";
import FlowWizard from "./pages/FlowWizard";
import Packages from "./pages/Packages";
import Backups from "./pages/Backups";
import K8s from "./pages/K8s";

const router = createBrowserRouter([
  {
    path: "/",
    element: <Shell />,
    children: [
      { index: true, element: <Overview /> },
      { path: "envs", element: <Envs /> },
      { path: "flows", element: <Flows /> },
      { path: "flows/:id", element: <FlowWizard /> },
      { path: "packages", element: <Packages /> },
      { path: "backups", element: <Backups /> },
      { path: "k8s", element: <K8s /> },
    ],
  },
]);

export default function App() {
  return <RouterProvider router={router} />;
}
