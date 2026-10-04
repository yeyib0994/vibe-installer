package com.cloudops.core;

import tools.jackson.databind.DeserializationFeature;
import tools.jackson.databind.ObjectMapper;

/** 全局 Jackson 配置。与 Python 端 model_dump(mode="json") 对齐：
 *  - snake_case（类级注解已处理）
 *  - LocalDateTime 序列化为 ISO 字符串（Jackson 3 内置 javatime 模块，自动发现）
 *  - 忽略未知字段，兼容旧数据
 */
public final class Json {
    private static final ObjectMapper MAPPER = new ObjectMapper().rebuild()
            .disable(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES)
            .findAndAddModules()
            .build();

    private Json() {}

    public static ObjectMapper mapper() {
        return MAPPER;
    }

    public static String toJson(Object o) {
        try {
            return MAPPER.writeValueAsString(o);
        } catch (Exception e) {
            throw new RuntimeException("JSON 序列化失败: " + e.getMessage(), e);
        }
    }

    public static <T> T fromJson(String json, Class<T> cls) {
        try {
            return MAPPER.readValue(json, cls);
        } catch (Exception e) {
            throw new RuntimeException("JSON 反序列化失败: " + e.getMessage(), e);
        }
    }
}
