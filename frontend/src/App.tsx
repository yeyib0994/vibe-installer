import { createBrowserRouter, Navigate, RouterProvider } from "react-router-dom";
import { Shell } from "./components/Shell";
import Overview from "./pages/Overview";
import Envs from "./pages/Envs";
import Flows from "./pages/Flows";
import FlowWizard from "./pages/FlowWizard";
import Packages from "./pages/Packages";
import Backups from "./pages/Backups";

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
      // 集群登记页已退役，旧书签落回总览而不是空白外壳
      { path: "k8s", element: <Navigate to="/" replace /> },
    ],
  },
]);

export default function App() {
  return <RouterProvider router={router} />;
}
