package com.cloudops.engine;

import org.springframework.stereotype.Component;

import java.time.LocalDateTime;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.function.Consumer;

/** 日志总线 —— 阶段执行器把日志/步骤状态推到这里，SSE 订阅者消费。 */
@Component
public class LogBus {

    private static final DateTimeFormatter TS = DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ss");

    private final Map<String, List<Consumer<Map<String, Object>>>> subs = new ConcurrentHashMap<>();
    private final Map<String, List<Map<String, Object>>> history = new ConcurrentHashMap<>();

    public void publish(String key, Map<String, Object> event) {
        event.putIfAbsent("ts", LocalDateTime.now().format(TS));
        history.computeIfAbsent(key, k -> new CopyOnWriteArrayList<>()).add(event);
        List<Consumer<Map<String, Object>>> callbacks = subs.getOrDefault(key, List.of());
        for (Consumer<Map<String, Object>> cb : callbacks) {
            try { cb.accept(event); } catch (Exception ignored) {}
        }
    }

    public void subscribe(String key, Consumer<Map<String, Object>> cb) {
        subs.computeIfAbsent(key, k -> new CopyOnWriteArrayList<>()).add(cb);
    }

    public void unsubscribe(String key, Consumer<Map<String, Object>> cb) {
        List<Consumer<Map<String, Object>>> list = subs.get(key);
        if (list != null) list.remove(cb);
    }

    public List<Map<String, Object>> history(String key) {
        return new ArrayList<>(history.getOrDefault(key, List.of()));
    }
}
