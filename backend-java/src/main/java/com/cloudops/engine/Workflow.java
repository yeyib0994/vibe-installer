package com.cloudops.engine;

import com.cloudops.core.Store;
import com.cloudops.model.FlowStage;
import com.cloudops.model.FlowStep;
import com.cloudops.model.InstallFlow;
import com.cloudops.model.PackageEntry;
import com.cloudops.model.enums.FlowStatus;
import com.cloudops.model.enums.StageStatus;
import com.cloudops.services.VersioningService;
import org.springframework.stereotype.Component;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/** 流程编排引擎。
 *
 * 把「安装」拆成有序阶段，每个阶段有输入表单、前置校验、执行步骤。
 * 阶段推进规则：阶段 0 初始 READY，其余 LOCKED；只有前一阶段 PASSED/SKIPPED，
 * 本阶段才从 LOCKED 升为 READY。
 */
@Component
public class Workflow {

    private final Store store;
    private final VersioningService versioning;

    public Workflow(Store store, VersioningService versioning) {
        this.store = store;
        this.versioning = versioning;
    }

    private static String sid() {
        return UUID.randomUUID().toString().replace("-", "").substring(0, 12);
    }

    // ===================== 表单字段 & 步骤构造器 =====================
    private static FlowStep step(int index, String title, String detail, String action) {
        FlowStep s = new FlowStep();
        s.id = sid();
        s.index = index;
        s.title = title;
        s.detail = detail;
        s.action = action;
        return s;
    }

    private static Map<String, Object> field(String key, String label, String type,
                                             boolean required, Object defaultValue,
                                             List<String> options, String placeholder,
                                             String helpText, boolean multilineList,
                                             List<Map<String, Object>> groups) {
        Map<String, Object> f = new HashMap<>();
        f.put("key", key);
        f.put("label", label);
        f.put("type", type);
        f.put("required", required);
        f.put("placeholder", placeholder != null ? placeholder : "");
        f.put("help", helpText != null ? helpText : "");
        f.put("hint", helpText != null ? helpText : "");
        if (defaultValue != null) f.put("default", defaultValue);
        if (options != null) {
            List<Map<String, String>> opts = new ArrayList<>();
            for (String o : options) opts.add(Map.of("value", o, "label", o));
            f.put("options", opts);
        }
        if (multilineList) f.put("multiline_list", true);
        if (groups != null) f.put("groups", groups);
        return f;
    }

    private static Map<String, Object> textField(String key, String label) {
        return field(key, label, "text", true, null, null, "", "", false, null);
    }
    private static Map<String, Object> textField(String key, String label, boolean required, Object def, String placeholder, String help) {
        return field(key, label, "text", required, def, null, placeholder, help, false, null);
    }
    private static Map<String, Object> numberField(String key, String label, Object def, String help) {
        return field(key, label, "number", false, def, null, "", help, false, null);
    }
    private static Map<String, Object> selectField(String key, String label, Object def, List<String> options, String help) {
        return field(key, label, "select", false, def, options, "", help, false, null);
    }
    private static Map<String, Object> boolField(String key, String label, boolean def, String help) {
        return field(key, label, "boolean", false, def, null, "", help, false, null);
    }
    private static Map<String, Object> textareaField(String key, String label, Object def, String placeholder, String help) {
        return field(key, label, "textarea", false, def, null, placeholder, help, true, null);
    }

    // 节点矩阵列定义
    private static final List<Map<String, Object>> PHYSICAL_COLUMNS = List.of(
            col("hostname", "主机名", 130), col("ip", "IP", 118),
            Map.of("key", "role", "label", "角色", "type", "role", "width", 104),
            col("vendor", "厂商", 92), col("model", "型号", 158),
            col("idc", "机房", 104), col("rack", "机柜", 78),
            col("nic_speed", "网卡", 78), col("raid_level", "RAID", 78),
            col("ssh_key_path", "SSH 私钥", 168)
    );
    private static final List<Map<String, Object>> VIRTUAL_COLUMNS = List.of(
            col("hostname", "主机名", 130), col("ip", "IP", 118),
            Map.of("key", "role", "label", "角色", "type", "role", "width", 104),
            col("host_platform", "虚拟化平台", 160),
            Map.of("key", "vcpu", "label", "vCPU", "type", "number", "width", 68),
            Map.of("key", "memory_gb", "label", "内存 GB", "type", "number", "width", 80),
            Map.of("key", "disk_gb", "label", "磁盘 GB", "type", "number", "width", 80),
            col("image_template", "镜像模板", 148),
            col("ssh_key_path", "SSH 私钥", 168)
    );

    private static Map<String, Object> col(String key, String label, int width) {
        return Map.of("key", key, "label", label, "width", width);
    }

    // ===================== 阶段定义：安装 =====================
    public List<FlowStage> buildInstallStages() {
        List<FlowStage> stages = new ArrayList<>();

        // 1. 环境登记
        FlowStage s1 = new FlowStage();
        s1.key = "env_register"; s1.index = 0; s1.title = "环境登记";
        s1.description = "按机器形态分组登记节点。物理机填型号与机房，虚机填规格与镜像模板。安装组件会根据节点角色自动分派。";
        s1.required = true;
        s1.formFields = List.of(
                textField("base_domain", "基础域名", false, null, "", "用于生成各服务的访问域名，可留空"),
                textField("ntp_server", "NTP 服务器", false, null, "ntp.internal.com", ""),
                textareaField("dns_servers", "DNS 服务器", null, "每行一个，如 10.0.0.10", ""),
                textField("timezone", "时区", false, "Asia/Shanghai", "", ""),
                numberField("control_count", "控制节点数", 3, "建议 3 或 5 台以保证高可用"),
                numberField("worker_count", "工作节点数", 5, ""),
                field("physical_nodes", "物理机列表", "node_table", false, new ArrayList<>(), null,
                        "逐台填写：主机名 / IP / 角色 / 品牌型号 / 机房机架 / 网卡 / RAID",
                        "逐台填写：主机名 / IP / 角色 / 品牌型号 / 机房机架 / 网卡 / RAID", false,
                        List.of(Map.of("key", "physical_nodes", "title", "物理机节点", "fields", PHYSICAL_COLUMNS))),
                field("virtual_nodes", "虚拟机列表", "node_table", false, new ArrayList<>(), null,
                        "逐台填写：主机名 / IP / 角色 / 虚拟化平台 / vCPU / 内存 / 磁盘 / 镜像模板",
                        "逐台填写：主机名 / IP / 角色 / 虚拟化平台 / vCPU / 内存 / 磁盘 / 镜像模板", false,
                        List.of(Map.of("key", "virtual_nodes", "title", "虚拟机节点", "fields", VIRTUAL_COLUMNS)))
        );
        s1.steps = List.of(
                step(0, "校验节点矩阵", "检查 IP 唯一性、角色覆盖、必填项完整性", "env.validate_matrix"),
                step(1, "生成节点清单", "按角色展开为待安装节点列表，落库", "env.persist_nodes")
        );
        stages.add(s1);

        // 2. 环境校验
        FlowStage s2 = new FlowStage();
        s2.key = "env_precheck"; s2.index = 1; s2.title = "环境校验";
        s2.description = "逐节点 SSH 探活并采集系统信息，执行安装前预检（内核参数、依赖命令、端口占用、磁盘、时间同步、SELinux）。";
        s2.required = true;
        s2.formFields = List.of(
                textField("ssh_user", "统一 SSH 用户", true, "root", "", ""),
                numberField("ssh_port", "SSH 端口", 22, ""),
                textField("ssh_key_path", "SSH 私钥路径", false, null, "留空则使用模拟模式，不真实连接节点", "有私钥时调用系统 ssh；留空则模拟执行，用于方案预演"),
                boolField("strict_mode", "严格模式", false, "开启后，任一节点预检不通过即阻断流程")
        );
        s2.steps = List.of(
                step(0, "SSH 连通性探测", "逐节点建连并采集主机名 / 内核 / 系统版本", "precheck.connect"),
                step(1, "系统预检", "检查依赖命令、端口占用、磁盘空间、时间同步、SELinux", "precheck.system"),
                step(2, "生成校验报告", "汇总各节点问题并给出修复建议", "precheck.report")
        );
        stages.add(s2);

        // 3. 上传安装包
        FlowStage s3 = new FlowStage();
        s3.key = "package_upload"; s3.index = 2; s3.title = "上传安装包";
        s3.description = "把安装包上传到控制台暂存区。大包会分片上传以便断点续传，上传完成后计算整包 SHA256 供分发校验。";
        s3.required = true;
        s3.formFields = List.of(
                selectField("package_kind", "包类型", "bundle", List.of("bundle", "image", "config", "patch"), "bundle=离线安装包，image=容器镜像，patch=补丁"),
                textField("package_version", "版本号", false, null, "v2.4.0", ""),
                numberField("expected_size", "预计大小（字节）", null, "用于上传进度校验，留空则自动读取")
        );
        s3.steps = List.of(
                step(0, "上传到暂存区", "接收文件流并落盘，计算 SHA256", "package.receive"),
                step(1, "分片与校验", "按 64MB 切分记录分片校验和，支持断点续传", "package.chunk"),
                step(2, "登记包清单", "写入包目录，供后续分发引用", "package.register")
        );
        stages.add(s3);

        // 4. 包分发
        FlowStage s4 = new FlowStage();
        s4.key = "package_distribute"; s4.index = 3; s4.title = "包分发";
        s4.description = "把安装包推送到各目标节点。默认 rsync（支持断点续传），推送后逐节点比对 SHA256 确保传输无损。";
        s4.required = true;
        s4.formFields = List.of(
                textField("remote_dir", "节点目标目录", true, "/opt/packages", "", ""),
                selectField("mode", "传输方式", "rsync", List.of("rsync", "scp"), "rsync 支持断点续传与增量，大包推荐"),
                numberField("concurrency", "并发数", 4, "同时传输的节点数，受带宽限制"),
                boolField("verify_checksum", "传输后校验 SHA256", true, ""),
                field("target_roles", "分发到哪些角色", "multiselect", true,
                        List.of("control", "worker", "database", "storage", "gateway"),
                        List.of("control", "worker", "database", "storage", "gateway"), "", "", false, null)
        );
        s4.steps = List.of(
                step(0, "连接目标节点", "确认各节点可达且目标目录可写", "distribute.connect"),
                step(1, "并发推送安装包", "按并发数分批推送，实时汇报进度", "distribute.push"),
                step(2, "校验远端完整性", "逐节点比对 SHA256，不一致则重传", "distribute.verify")
        );
        stages.add(s4);

        // 5. 安装前备份
        FlowStage s5 = new FlowStage();
        s5.key = "pre_install_backup"; s5.index = 4; s5.title = "安装前备份";
        s5.description = "对环境中已有数据做备份点，用于安装失败时恢复。全新环境无历史数据，可跳过本阶段。";
        s5.required = false;
        s5.formFields = List.of(
                textField("backup_name", "备份点名称", false, null, "留空则自动生成", ""),
                textareaField("include_paths", "备份目录", List.of("/etc", "/var/lib", "/opt/data"), "每行一个目录", "将被归档的目录，与数据库至少填一项"),
                textareaField("include_databases", "备份数据库", new ArrayList<>(), "每行一个实例名，如 appdb", "按实例名在数据库节点上执行逻辑备份"),
                boolField("include_paths_allow_glob", "允许目录通配符由远端展开", false, "默认逐项加引号（远端不展开，只接受字母数字与 . _ / -）；开启后可写 /etc/app/* 这类通配符，但会拒绝一切 shell 控制字符"),
                boolField("include_config", "包含配置文件", true, ""),
                numberField("retention_days", "保留天数", 30, "超过保留期的备份点会被标记为过期，可清理释放空间")
        );
        s5.steps = List.of(
                step(0, "确认备份范围", "列出将被备份的目录、数据库实例与目标节点", "backup.scope"),
                step(1, "执行文件归档", "逐节点打包目录，计算校验和", "backup.archive"),
                step(2, "执行数据库逻辑备份", "对数据库节点执行 dump 并回传到控制台", "backup.database"),
                step(3, "登记备份点", "写入备份目录，设置过期时间，生成回滚基线", "backup.register")
        );
        stages.add(s5);

        // 6. 执行安装
        FlowStage s6 = new FlowStage();
        s6.key = "install_execute"; s6.index = 5; s6.title = "执行安装";
        s6.description = "按节点角色分派组件并安装。控制节点装管理组件，工作节点装运行组件，数据库/存储节点装数据组件。任一节点失败会停止后续节点并给出回滚入口。";
        s6.required = true;
        s6.formFields = List.of(
                selectField("install_mode", "安装模式", "full", List.of("full", "incremental", "repair"), "full=整装，incremental=增量，repair=修复重装"),
                boolField("stop_on_failure", "失败即停", true, "关闭则继续处理剩余节点并汇总失败清单"),
                numberField("parallel_workers", "工作节点并发度", 3, ""),
                textareaField("skip_components", "跳过的组件", new ArrayList<>(), "每行一个组件名", "")
        );
        s6.steps = List.of(
                step(0, "分发前置检查", "确认所有节点已收到安装包且校验通过", "install.precheck"),
                step(1, "安装控制面组件", "在控制节点安装管理服务并初始化集群", "install.control_plane"),
                step(2, "安装数据面组件", "在数据库与存储节点初始化数据服务", "install.data_plane"),
                step(3, "安装工作节点组件", "在工作节点安装运行组件并加入集群", "install.workers"),
                step(4, "安装网关组件", "配置接入层、证书与负载均衡", "install.gateway")
        );
        stages.add(s6);

        // 7. 安装后验证
        FlowStage s7 = new FlowStage();
        s7.key = "post_verify"; s7.index = 6; s7.title = "安装后验证";
        s7.description = "逐项验证安装结果：服务状态、端口监听、版本一致性、集群成员、核心接口连通性，最后生成交付报告。";
        s7.required = true;
        s7.formFields = List.of(
                field("smoke_endpoints", "冒烟测试接口（逗号分隔）", "text", false,
                        List.of("/healthz", "/api/v1/version"), null, "", "", false, null),
                boolField("verify_cluster", "校验集群成员一致性", true, ""),
                boolField("keep_backup", "保留安装前备份点", true, "关闭则在验证通过后清理备份以释放空间")
        );
        s7.steps = List.of(
                step(0, "服务状态检查", "逐节点检查系统服务与进程状态", "verify.services"),
                step(1, "端口监听检查", "确认关键端口处于监听状态", "verify.ports"),
                step(2, "版本一致性核对", "比对各节点组件版本是否统一", "verify.versions"),
                step(3, "集群成员检查", "确认所有节点已正确加入集群", "verify.membership"),
                step(4, "接口冒烟测试", "对核心接口发起请求验证可用性", "verify.smoke"),
                step(5, "生成交付报告", "汇总安装结果、节点清单与遗留问题", "verify.report")
        );
        stages.add(s7);

        return stages;
    }

    // ===================== 阶段定义：K8s 升级 =====================
    public List<FlowStage> buildUpgradeK8sStages() {
        List<FlowStage> stages = new ArrayList<>();

        // 0. 环境登记
        FlowStage s0 = new FlowStage();
        s0.key = "env_register"; s0.index = 0; s0.title = "环境登记";
        s0.description = "登记目标 K8s 集群与待升级的 Helm Release。";
        s0.required = true;
        s0.formFields = List.of(
                textField("cluster_id", "K8s 集群 ID", true, null, "", "已登记的集群 ID，或留空使用默认 KUBECONFIG"),
                textField("kubeconfig", "kubeconfig 路径/内容", false, null, "", "留空则使用集群 ID 关联的凭证或默认 KUBECONFIG"),
                textField("namespace", "命名空间", true, "default", "", "Helm Release 所在命名空间"),
                textField("release_name", "Helm Release 名称", true, null, "my-release", ""),
                textField("chart", "Chart 名称/路径", true, null, "repo/chart", "如 myrepo/myapp 或 ./chart"),
                textField("target_chart_version", "目标 Chart 版本", true, null, "2.5.0", ""),
                textField("chart_repo", "Chart 仓库地址", false, null, "https://charts.example.com", "私有仓库需提前配置凭证")
        );
        s0.steps = List.of(
                step(0, "发现 Release", "读取当前 Helm Release 版本与关联 workload", "k8s.discover"),
                step(1, "锁定升级目标", "记录当前 chart 版本与 revision 作为回滚基线", "k8s.lock_target")
        );
        stages.add(s0);

        // 1. 环境校验
        FlowStage s1 = new FlowStage();
        s1.key = "env_precheck"; s1.index = 1; s1.title = "环境校验";
        s1.description = "节点层（Python）+ K8s 层（TS）双重校验：节点资源/端口/依赖、Pod 就绪度、版本兼容性。";
        s1.required = true;
        s1.formFields = List.of(
                textField("ssh_user", "统一 SSH 用户", false, "root", "", "节点层预检用，留空则跳过主机预检"),
                numberField("ssh_port", "SSH 端口", 22, ""),
                textField("ssh_key_path", "SSH 私钥路径", false, null, "", "留空则使用模拟模式"),
                boolField("check_compat", "检查版本兼容性", true, ""),
                numberField("min_ready_replicas", "最低就绪副本", 1, "每个 workload 的最低就绪 Pod 数")
        );
        s1.steps = List.of(
                step(0, "节点预检", "Python 脚本：SSH 探活、OS/资源/端口/依赖检查", "precheck.node"),
                step(1, "K8s 健康检查", "TS 脚本：所有 Pod Running+Ready、无 CrashLoopBackOff", "precheck.k8s_health"),
                step(2, "版本兼容性", "跨主版本升级需停机提示", "precheck.compat"),
                step(3, "生成校验报告", "合并主机层 + K8s 层报告", "precheck.report")
        );
        stages.add(s1);

        // 2. 升级前备份
        FlowStage s2 = new FlowStage();
        s2.key = "pre_upgrade_backup"; s2.index = 2; s2.title = "升级前备份";
        s2.description = "导出 Helm values/manifest，对有状态 PVC 打 VolumeSnapshot。";
        s2.required = true;
        s2.formFields = List.of(
                textField("backup_name", "备份点名称", false, null, "", ""),
                boolField("backup_values", "备份 Helm Values", true, "导出当前 release 的 values 为 JSON"),
                boolField("backup_manifest", "备份 Release Manifest", true, "导出 helm get manifest 完整清单"),
                boolField("backup_pvc", "备份 PVC 快照", true, "对 StatefulSet 的 PVC 创建 VolumeSnapshot"),
                textField("snapshot_class", "VolumeSnapshotClass", false, "default", "", "集群需已配置 VolumeSnapshotClass"),
                numberField("retention_days", "保留天数", 30, "")
        );
        s2.steps = List.of(
                step(0, "确认备份范围", "列出将备份的 values/manifest/PVC", "backup.scope"),
                step(1, "导出 Helm Values", "TS：helm get values -o json", "backup.helm_values"),
                step(2, "导出 Release Manifest", "TS：helm get manifest", "backup.helm_manifest"),
                step(3, "PVC 快照", "TS：创建 VolumeSnapshot", "backup.pvc_snapshot"),
                step(4, "登记备份点", "标记为回滚基线", "backup.register")
        );
        stages.add(s2);

        // 3. 执行升级
        FlowStage s3 = new FlowStage();
        s3.key = "upgrade_execute"; s3.index = 3; s3.title = "执行升级";
        s3.description = "通过 Helm 升级 chart，节点 drain/uncordon 由 Python 执行，Pod 就绪校验由 TS 执行。";
        s3.required = true;
        s3.formFields = List.of(
                selectField("strategy", "升级策略", "rolling",
                        List.of("rolling", "canary", "blue_green"), "rolling=滚动，canary=灰度，blue_green=蓝绿"),
                textField("max_surge", "maxSurge", false, "25%", "", "滚动升级 surge 参数"),
                textField("max_unavailable", "maxUnavailable", false, "25%", "", "滚动升级不可用比例"),
                numberField("batch_size", "灰度批次大小", 1, "canary 策略下每批升级的副本数"),
                numberField("pause_between_batches", "批次间观察（秒）", 30, ""),
                boolField("auto_rollback", "失败自动回滚", true, ""),
                textareaField("set_values", "Values 覆盖（YAML/JSON）", new ArrayList<>(), "key=value 每行一个", "覆盖 chart 默认值")
        );
        s3.steps = List.of(
                step(0, "节点排水", "Python：kubectl drain 驱逐节点（可选，按批次）", "upgrade.node_drain"),
                step(1, "Helm 升级", "TS：helm upgrade --install 到目标版本", "upgrade.helm_upgrade"),
                step(2, "Rollout 等待", "TS：kubectl rollout status 等待所有 workload 就绪", "upgrade.rollout_status"),
                step(3, "数据迁移", "TS：执行数据库迁移 Job（若 chart 提供）", "upgrade.migrate_data"),
                step(4, "节点恢复调度", "Python：kubectl uncordon", "upgrade.node_uncordon"),
                step(5, "ConfigMap 热更新", "TS：滚动重启使新 ConfigMap 生效", "upgrade.config_roll")
        );
        stages.add(s3);

        // 4. 升级后验证
        FlowStage s4 = new FlowStage();
        s4.key = "post_verify"; s4.index = 4; s4.title = "升级后验证";
        s4.description = "TS 校验：所有 Pod Ready、镜像版本一致、冒烟接口可访问。";
        s4.required = true;
        s4.formFields = List.of(
                field("smoke_endpoints", "冒烟测试接口（逗号分隔）", "text", false,
                        List.of("/healthz", "/version"), null, "", "", false, null),
                boolField("verify_version", "校验镜像版本", true, "确认所有 Pod 镜像 = 目标版本"),
                boolField("keep_backup", "保留升级前备份", true, "")
        );
        s4.steps = List.of(
                step(0, "Pod 就绪校验", "TS：所有 Pod Running+Ready，无 CrashLoop", "verify.pods"),
                step(1, "版本一致性", "TS：kubectl get images 校验镜像 tag", "verify.version"),
                step(2, "冒烟测试", "TS：通过 Service 访问冒烟接口", "verify.smoke"),
                step(3, "生成升级报告", "汇总升级结果", "verify.report")
        );
        stages.add(s4);

        // 5. 回滚预案
        FlowStage s5 = new FlowStage();
        s5.key = "rollback_plan"; s5.index = 5; s5.title = "回滚预案";
        s5.description = "生成回滚命令清单，可手动或自动触发。不执行实际回滚。";
        s5.required = false;
        s5.formFields = List.of(
                selectField("trigger", "回滚触发方式", "manual", List.of("manual", "auto", "none"), ""),
                numberField("rollback_to_revision", "回滚到 revision", 0, "0=上一版本，或指定 revision 号")
        );
        s5.steps = List.of(
                step(0, "版本差异对比", "TS：helm diff 对比当前与目标版本", "rollback.diff"),
                step(1, "生成回滚命令", "TS：输出 helm rollback 命令清单", "rollback.steps")
        );
        stages.add(s5);

        return stages;
    }

    // ===================== 流程工厂 =====================
    public InstallFlow createFlow(String name, String envId, String mode, String operator) {
        List<FlowStage> stages = switch (mode) {
            case "install" -> buildInstallStages();
            case "upgrade_k8s" -> buildUpgradeK8sStages();
            default -> buildInstallStages();
        };
        if (!stages.isEmpty()) stages.get(0).status = StageStatus.READY;

        InstallFlow flow = new InstallFlow();
        flow.id = sid();
        flow.name = name;
        flow.envId = envId;
        flow.mode = mode;
        flow.stages = stages;
        flow.status = FlowStatus.DRAFT;
        flow.operator = operator != null ? operator : "admin";
        return flow;
    }

    /** 返回某模式的工作流目录（阶段 + 表单字段），供前端渲染。 */
    public java.util.Map<String, Object> catalog(String mode) {
        List<FlowStage> stages = switch (mode) {
            case "upgrade_k8s" -> buildUpgradeK8sStages();
            default -> buildInstallStages();
        };
        java.util.Map<String, Object> out = new java.util.HashMap<>();
        out.put("mode", mode);
        out.put("stages", stages);
        return out;
    }

    public InstallFlow refreshLocks(InstallFlow flow) {
        for (int i = 0; i < flow.stages.size(); i++) {
            FlowStage st = flow.stages.get(i);
            if (st.status == StageStatus.PASSED || st.status == StageStatus.SKIPPED
                    || st.status == StageStatus.RUNNING || st.status == StageStatus.FAILED) {
                continue;
            }
            if (i == 0) {
                st.status = StageStatus.READY;
            } else {
                FlowStage prev = flow.stages.get(i - 1);
                if (prev.status == StageStatus.PASSED || prev.status == StageStatus.SKIPPED) {
                    st.status = StageStatus.READY;
                } else {
                    st.status = StageStatus.LOCKED;
                }
            }
        }
        int cur = flow.stages.size() - 1;
        for (int i = 0; i < flow.stages.size(); i++) {
            StageStatus s = flow.stages.get(i).status;
            if (s == StageStatus.READY || s == StageStatus.RUNNING || s == StageStatus.FAILED) {
                cur = i;
                break;
            }
        }
        flow.currentStage = cur;
        return flow;
    }

    public FlowStage stageByKey(InstallFlow flow, String key) {
        for (FlowStage s : flow.stages) if (s.key.equals(key)) return s;
        return null;
    }

    public String upstreamReady(InstallFlow flow, String key) {
        FlowStage st = stageByKey(flow, key);
        if (st == null) return "阶段 " + key + " 不存在";
        if (st.status == StageStatus.LOCKED) {
            FlowStage prev = st.index > 0 ? flow.stages.get(st.index - 1) : null;
            return prev != null ? prev.title : "前置阶段";
        }
        return null;
    }

    // ===================== 输入校验 =====================
    @SuppressWarnings("unchecked")
    public List<String> validateStageInputs(InstallFlow flow, String key, Map<String, Object> inputs) {
        FlowStage st = stageByKey(flow, key);
        if (st == null) return List.of("阶段 " + key + " 不存在");

        List<String> errors = new ArrayList<>();
        for (Map<String, Object> f : st.formFields) {
            String k = (String) f.get("key");
            Object val = inputs.containsKey(k) ? inputs.get(k) : f.get("default");
            boolean required = Boolean.TRUE.equals(f.get("required"));
            if (required && isEmpty(val)) {
                errors.add("「" + f.get("label") + "」为必填项");
            }
            if ("number".equals(f.get("type")) && val != null && !val.toString().isEmpty()) {
                try {
                    int iv = Integer.parseInt(val.toString());
                    if (iv < 0) errors.add("「" + f.get("label") + "」不能为负数");
                } catch (NumberFormatException e) {
                    errors.add("「" + f.get("label") + "」必须是数字");
                }
            }
        }

        // 业务级校验：install 的 env_register 提交节点表格（upgrade 模式已退役，环境确认那一条随之删除）。
        if ("env_register".equals(key) && "install".equals(flow.mode)) {
            List<Map<String, Object>> physical = asNodeList(inputs.get("physical_nodes"));
            List<Map<String, Object>> virtual = asNodeList(inputs.get("virtual_nodes"));
            int total = physical.size() + virtual.size();
            if (total == 0) errors.add("至少需要登记 1 台节点（物理机或虚拟机）");

            List<String> ips = new ArrayList<>();
            for (Map<String, Object> n : physical) {
                String ip = str(n.get("ip")).strip();
                String host = str(n.get("hostname"));
                if (ip.isEmpty()) errors.add("节点 " + (host.isEmpty() ? "(未命名)" : host) + " 缺少 IP");
                else if (ips.contains(ip)) errors.add("IP " + ip + " 重复登记");
                else ips.add(ip);
                if (host.isEmpty()) errors.add("存在未填写主机名的节点");
            }
            for (Map<String, Object> n : virtual) {
                String ip = str(n.get("ip")).strip();
                String host = str(n.get("hostname"));
                if (ip.isEmpty()) errors.add("节点 " + (host.isEmpty() ? "(未命名)" : host) + " 缺少 IP");
                else if (ips.contains(ip)) errors.add("IP " + ip + " 重复登记");
                else ips.add(ip);
                if (host.isEmpty()) errors.add("存在未填写主机名的节点");
            }

            long ctrl = physical.stream().filter(n -> "control".equals(n.get("role"))).count()
                    + virtual.stream().filter(n -> "control".equals(n.get("role"))).count();
            Object wantCtrl = inputs.get("control_count");
            if (wantCtrl != null) {
                try {
                    int wc = Integer.parseInt(wantCtrl.toString());
                    if (ctrl != wc) errors.add("控制节点实际登记 " + ctrl + " 台，与声明的 " + wc + " 台不一致");
                } catch (NumberFormatException ignored) {}
            }
            if (ctrl > 0 && ctrl % 2 == 0) errors.add("控制节点为 " + ctrl + " 台（偶数），etcd 类组件建议奇数台以保证选主");
            if (ctrl == 1) errors.add("仅 1 台控制节点，不具备高可用能力，生产环境不建议");

            for (Map<String, Object> n : physical) {
                String host = str(n.get("hostname")).isEmpty() ? str(n.get("ip")) : str(n.get("hostname"));
                for (String[] pair : new String[][]{{"vendor", "品牌"}, {"model", "型号"}, {"idc", "机房"}}) {
                    if (str(n.get(pair[0])).strip().isEmpty()) errors.add("物理机 " + host + " 缺少「" + pair[1] + "」");
                }
            }
            for (Map<String, Object> n : virtual) {
                String host = str(n.get("hostname")).isEmpty() ? str(n.get("ip")) : str(n.get("hostname"));
                for (String[] pair : new String[][]{{"host_platform", "虚拟化平台"}, {"vcpu", "vCPU"}, {"memory_gb", "内存"}, {"disk_gb", "磁盘"}}) {
                    if (n.get(pair[0]) == null || str(n.get(pair[0])).isEmpty()) errors.add("虚拟机 " + host + " 缺少「" + pair[1] + "」");
                }
            }
        }

        if ("package_upload".equals(key)) {
            if (isEmpty(inputs.get("_package_id"))) errors.add("尚未上传任何安装包");
        }

        if ("package_distribute".equals(key)) {
            List<String> pkgs = asStringList(inputs.get("_package_ids"));
            if (pkgs.isEmpty() && !isEmpty(inputs.get("_package_id"))) {
                pkgs = List.of(str(inputs.get("_package_id")));
            }
            if (pkgs.isEmpty()) {
                for (PackageEntry p : store.listPackages()) {
                    if (p.uploadComplete) pkgs.add(p.id);
                }
            }
            if (pkgs.isEmpty()) errors.add("尚未上传任何安装包，请先完成「上传安装包」阶段");
            String dir = str(inputs.get("remote_dir")).strip();
            if (dir.isEmpty()) errors.add("「节点目标目录」为必填项");
            else if (!dir.startsWith("/")) errors.add("「节点目标目录」必须是绝对路径（以 / 开头）");
            else if (!dir.matches("[A-Za-z0-9._/-]+")) errors.add("「节点目标目录」只能包含字母、数字和 . _ / -（该值会拼入远程命令）");
            if (asStringList(inputs.get("target_roles")).isEmpty()) errors.add("「分发到哪些角色」至少选择一个");
            checkConcurrency(inputs.get("concurrency"), "并发数", errors);
        }

        if ("install_execute".equals(key)) {
            checkConcurrency(inputs.get("parallel_workers"), "工作节点并发度", errors);
        }

        if (("pre_install_backup".equals(key) || "pre_upgrade_backup".equals(key)) && !"upgrade_k8s".equals(flow.mode)) {
            List<String> paths = asStringList(inputs.get("include_paths"));
            List<String> dbs = asStringList(inputs.get("include_databases"));
            boolean includeConfig = Boolean.TRUE.equals(inputs.get("include_config"));
            if (paths.isEmpty() && dbs.isEmpty() && !includeConfig) {
                errors.add("备份范围为空：至少选择备份目录、数据库或配置文件之一");
            }
            boolean allowGlob = Boolean.TRUE.equals(inputs.get("include_paths_allow_glob"));
            for (String p : paths) checkBackupPath(p, allowGlob, errors);
            for (String db : dbs) checkBackupDatabase(db, errors);
        }

        return errors;
    }

    // ===================== 工具方法 =====================
    /**
     * 备份目录会被拼进远端 `tar czf …` 的参数位（StageExecutor.actBackupArchive），
     * 规则与「节点目标目录」同源：这些值进的是 shell，不是 argv。
     * 关闭通配符时只允许字母数字与 . _ / -（逐项加引号，远端不展开）；
     * 开启时额外放行 * ? [ ] ~，但任何 shell 控制字符都仍然直接拒绝。
     */
    private static final String BACKUP_PATH_PLAIN = "[A-Za-z0-9._/-]+";
    private static final String BACKUP_PATH_GLOB = "[A-Za-z0-9._/\\-*?~\\[\\]]+";

    private static void checkBackupPath(String path, boolean allowGlob, List<String> errors) {
        String label = allowGlob ? "「备份目录」" : "「备份目录」（需要通配符请开启「允许目录通配符由远端展开」）";
        if (path.startsWith("-")) {
            errors.add("「备份目录」不能以 - 开头（会被当作命令选项）：" + path);
        } else if (path.contains("..")) {
            errors.add("「备份目录」不能包含 ..：" + path);
        } else if (path.matches(".*[;|&$()`<>\\\\'\"\\s].*")) {
            errors.add("「备份目录」含有 shell 控制字符（; | & $ ( ) < > 反引号 引号 空白 反斜杠）：" + path);
        } else if (!path.matches(allowGlob ? BACKUP_PATH_GLOB : BACKUP_PATH_PLAIN)) {
            errors.add(label + "只能包含字母、数字和 . _ / -" + (allowGlob ? " 以及 * ? [ ] ~" : "") + "（该值会拼入远程命令）：" + path);
        }
    }

    /** 库名既拼进 `mysqldump`/`pg_dump` 的参数位，也直接当落盘文件名用，所以字符集要同时满足两边。 */
    private static void checkBackupDatabase(String db, List<String> errors) {
        if (!db.matches("[A-Za-z0-9][A-Za-z0-9._-]*")) {
            errors.add("「备份数据库」实例名只能由字母、数字和 . _ - 组成，且不能以 - 开头（该值会拼入远程命令并用作 dump 文件名）：" + db);
        }
    }

    /** 并发度会被当作循环步长使用，0 会让批次推进永不结束，所以在提交阶段就拦住。 */
    private static void checkConcurrency(Object val, String label, List<String> errors) {
        if (val == null || val.toString().isBlank()) return;
        try {
            int v = Integer.parseInt(val.toString().strip());
            if (v < 1 || v > 32) errors.add("「" + label + "」需在 1~32 之间（当前 " + v + "）");
        } catch (NumberFormatException ignored) {
        }
    }

    private static boolean isEmpty(Object v) {
        if (v == null) return true;
        if (v instanceof String s) return s.isEmpty();
        if (v instanceof List<?> l) return l.isEmpty();
        return false;
    }

    private static String str(Object v) {
        return v == null ? "" : v.toString();
    }

    @SuppressWarnings("unchecked")
    public static List<Map<String, Object>> asNodeList(Object v) {
        if (v instanceof List<?> l) {
            List<Map<String, Object>> out = new ArrayList<>();
            for (Object o : l) if (o instanceof Map) out.add((Map<String, Object>) o);
            return out;
        }
        return new ArrayList<>();
    }

    @SuppressWarnings("unchecked")
    public static List<String> asStringList(Object v) {
        if (v == null) return new ArrayList<>();
        if (v instanceof String s) {
            String[] parts = s.replace("，", ",").split(",");
            List<String> out = new ArrayList<>();
            for (String p : parts) if (!p.strip().isEmpty()) out.add(p.strip());
            return out;
        }
        if (v instanceof List<?> l) {
            List<String> out = new ArrayList<>();
            for (Object o : l) {
                if (o instanceof List<?> sub) {
                    out.addAll(asStringList(sub));
                } else {
                    String s = o == null ? "" : o.toString().strip();
                    if (!s.isEmpty()) out.add(s);
                }
            }
            return out;
        }
        return List.of(str(v).strip());
    }
}
