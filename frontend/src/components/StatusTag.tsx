import { Tag } from "./ui/Tag";
import {
  BACKUP_STATUS_CN, FLOW_STATUS_CN, STAGE_CN, STATUS_CN, statusTone,
} from "../lib/labels";

const MAP = {
  stage: STAGE_CN as Record<string, string>,
  flow: FLOW_STATUS_CN as Record<string, string>,
  node: STATUS_CN as Record<string, string>,
  backup: BACKUP_STATUS_CN as Record<string, string>,
};

export function StatusTag({ kind, value }: { kind: keyof typeof MAP; value: string }) {
  return <Tag tone={statusTone(value)}>{MAP[kind][value] ?? value}</Tag>;
}
