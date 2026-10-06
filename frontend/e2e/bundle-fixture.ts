import { gzipSync } from "zlib";

/**
 * E2E 用的离线 bundle 夹具：后端 `BundleUnpacker` 真会解这个包，所以这里的 tar 必须是合规的
 * POSIX ustar，而不是一段「看起来像 tar.gz」的字节。不引第三方 tar 依赖 —— 验收栈不该因为装包而红。
 *
 * 头块字段布局（每块 512 字节）：
 * name[100] mode[8] uid[8] gid[8] size[8] mtime[12] chksum[8] typeflag[1] linkname[100]
 * magic[6]="ustar\0" version[2]="00" uname[32] gname[32] devmajor[8] devminor[8] prefix[155]
 */
function ustar(name: string, body: Buffer): Buffer {
  const nameBytes = Buffer.from(name, "utf8");
  if (nameBytes.length > 99) throw new Error(`条目名过长（>99 字节），ustar 前缀分段夹具不支持：${name}`);
  const header = Buffer.alloc(512);
  nameBytes.copy(header, 0);
  header.write("0000644\0", 100, 8, "ascii");
  header.write("0000000\0", 108, 8, "ascii");
  header.write("0000000\0", 116, 8, "ascii");
  header.write(`${body.length.toString(8).padStart(11, "0")}\0`, 124, 12, "ascii");
  header.write(`${Math.floor(Date.now() / 1000).toString(8).padStart(11, "0")}\0`, 136, 12, "ascii");
  // chksum 字段在求和期间必须是空格，否则读端算出来的和与写端不一致（GNU tar / commons-compress 都按这个约定校验）
  header.write("        ", 148, 8, "ascii");
  header.write("0", 156, 1, "ascii");
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");
  header.write("root\0\0\0\0", 265, 8, "ascii");
  header.write("root\0\0\0\0", 297, 8, "ascii");
  let sum = 0;
  for (const b of header) sum += b;
  header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
  const padding = body.length % 512 === 0 ? 0 : 512 - (body.length % 512);
  return Buffer.concat([header, body, Buffer.alloc(padding)]);
}

export function tar(entries: { name: string; body: Buffer }[]): Buffer {
  return Buffer.concat([...entries.map((e) => ustar(e.name, e.body)), Buffer.alloc(1024)]);
}

/** chart 包：BundleUnpacker 会读里面的 Chart.yaml 取 name/version，所以这两项必须真的写进去。 */
function chartTgz(chartVersion: string): Buffer {
  return gzipSync(tar([
    {
      name: "shipdesk-e2e/Chart.yaml",
      body: Buffer.from(`apiVersion: v2\nname: shipdesk-e2e\nversion: ${chartVersion}\n`, "utf8"),
    },
    {
      name: "shipdesk-e2e/templates/configmap.yaml",
      body: Buffer.from("apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: shipdesk-e2e\n", "utf8"),
    },
  ]));
}

/** 合规离线包：目录约定是 chart/<name>-<version>.tgz + 顶层 values.yaml + images/*.tar。 */
export function buildBundle(chartVersion: string): Buffer {
  return gzipSync(tar([
    { name: "README.txt", body: Buffer.from("ShipDesk E2E 离线包\n", "utf8") },
    { name: `chart/shipdesk-e2e-${chartVersion}.tgz`, body: chartTgz(chartVersion) },
    { name: "values.yaml", body: Buffer.from("replicaCount: 2\n", "utf8") },
    { name: "images/app.tar", body: Buffer.alloc(2048, "i") },
  ]));
}

/** 不合规包：只有镜像和 values，没有 chart —— 用来验阶段失败与目录约定提示。 */
export function buildBundleWithoutChart(): Buffer {
  return gzipSync(tar([
    { name: "images/app.tar", body: Buffer.alloc(512, "i") },
    { name: "values.yaml", body: Buffer.from("replicaCount: 1\n", "utf8") },
  ]));
}
