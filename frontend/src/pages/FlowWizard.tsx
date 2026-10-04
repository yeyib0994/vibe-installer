import { useParams } from "react-router-dom";

export default function FlowWizard() {
  const { id } = useParams();
  return <div className="text-sm text-ink-mute">流程向导占位 {id}</div>;
}
