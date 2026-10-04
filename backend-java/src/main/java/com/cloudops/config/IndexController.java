package com.cloudops.config;

import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

/** 健康检查与内联 favicon。前端已独立部署，不再提供根路径兜底路由。 */
@RestController
public class IndexController {

    @GetMapping("/healthz")
    public ResponseEntity<java.util.Map<String, String>> healthz() {
        return ResponseEntity.ok(java.util.Map.of("status", "ok"));
    }

    @GetMapping(value = "/favicon.ico", produces = "image/svg+xml")
    public ResponseEntity<String> favicon() {
        String svg = "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 32 32\">"
                + "<rect width=\"32\" height=\"32\" rx=\"7\" fill=\"#2563eb\"/>"
                + "<path d=\"M8 22V13l5 3 5-3v9\" stroke=\"#fff\" stroke-width=\"2.2\" fill=\"none\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/>"
                + "<circle cx=\"23\" cy=\"19\" r=\"3\" stroke=\"#fff\" stroke-width=\"2\" fill=\"none\"/></svg>";
        return ResponseEntity.ok()
                .header("Cache-Control", "public, max-age=86400")
                .contentType(MediaType.valueOf("image/svg+xml"))
                .body(svg);
    }
}
