package com.cloudops.config;

import org.springframework.context.annotation.Configuration;
import org.springframework.web.servlet.config.annotation.CorsRegistry;
import org.springframework.web.servlet.config.annotation.ResourceHandlerRegistry;
import org.springframework.web.servlet.config.annotation.WebMvcConfigurer;

import java.nio.file.Path;
import java.nio.file.Paths;

@Configuration
public class WebConfig implements WebMvcConfigurer {

    @Override
    public void addCorsMappings(CorsRegistry registry) {
        registry.addMapping("/**")
                .allowedOriginPatterns("*")
                .allowedMethods("*")
                .allowedHeaders("*")
                .allowCredentials(true);
    }

    /** 把前端目录挂到 /static，根路径 / 返回 index.html。 */
    @Override
    public void addResourceHandlers(ResourceHandlerRegistry registry) {
        Path frontendDir = Paths.get("..", "frontend").toAbsolutePath().normalize();
        if (!java.nio.file.Files.exists(frontendDir)) {
            frontendDir = Paths.get("frontend").toAbsolutePath().normalize();
        }
        String loc = frontendDir.toUri().toString();
        registry.addResourceHandler("/static/**").addResourceLocations(loc);
        registry.addResourceHandler("/favicon.ico").addResourceLocations(loc);
    }
}
