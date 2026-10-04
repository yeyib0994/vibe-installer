package com.cloudops;

import com.cloudops.core.Seed;
import com.cloudops.core.Store;
import org.springframework.boot.CommandLineRunner;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.context.annotation.Bean;

@SpringBootApplication
public class CloudOpsApplication {

    public static void main(String[] args) {
        SpringApplication.run(CloudOpsApplication.class, args);
    }

    /** 启动时初始化数据库并灌入示例数据。 */
    @Bean
    public CommandLineRunner startup(Store store, Seed seed) {
        return args -> {
            // 触发连接创建（建表）
            store.listEnvs();
            seed.seedIfEmpty();
            System.out.println("CloudOps Console 启动完成 → http://127.0.0.1:8848");
        };
    }
}
