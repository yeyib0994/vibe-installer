package com.cloudops;

import com.cloudops.core.Seed;
import com.cloudops.core.Store;
import org.springframework.boot.CommandLineRunner;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.context.annotation.Bean;
import org.springframework.core.env.Environment;

@SpringBootApplication
public class CloudOpsApplication {

    public static void main(String[] args) {
        SpringApplication.run(CloudOpsApplication.class, args);
    }

    /** 启动时初始化数据库并灌入示例数据。 */
    @Bean
    public CommandLineRunner startup(Store store, Seed seed, Environment env) {
        return args -> {
            // 触发连接创建（建表）
            store.listEnvs();
            seed.seedIfEmpty();
            // 端口取实际生效的配置：写死 8848 会在换端口启动时把运维指向一个没人监听的地址
            System.out.println("CloudOps Console 启动完成 → http://127.0.0.1:" + env.getProperty("server.port", "8848"));
        };
    }
}
