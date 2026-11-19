# Spring Boot 3: Sentry setup

Verified with Spring Boot 3.5.16, Java 21, `io.sentry:sentry-spring-boot-starter-jakarta` **8.65.0** (latest on
Maven Central when this was written: check for a newer version and use it if it is still compatible).
Use `sentry-spring-boot-starter-jakarta`, not the non-jakarta starter, which is for Spring Boot 2.

Replace `<base-package>` with the application's base package (the one holding the `@SpringBootApplication`
class) and put the files under `src/main/java/<base-package path>/observability/`.

## 1. Dependency

Maven (`pom.xml`), inside `<dependencies>`; Spring Boot's BOM does not manage Sentry, so the version is explicit:

```xml
<dependency>
    <groupId>io.sentry</groupId>
    <artifactId>sentry-spring-boot-starter-jakarta</artifactId>
    <version>8.65.0</version>
</dependency>
```

Gradle: `implementation("io.sentry:sentry-spring-boot-starter-jakarta:8.65.0")`.

## 2. Properties

Append to `application.properties` (or the YAML equivalent, keeping the same keys and defaults). Do not touch
existing `sentry.*` keys; add only the missing ones.

```properties
# Sentry. An empty DSN disables the SDK (local dev, tests, builds without network).
# The data region (EU) is decided by the DSN host (ingest.de.sentry.io), not by a property.
sentry.dsn=${SENTRY_DSN:}
sentry.environment=${SENTRY_ENVIRONMENT:local}
sentry.release=${SENTRY_RELEASE:}
sentry.send-default-pii=false
sentry.traces-sample-rate=${SENTRY_TRACES_SAMPLE_RATE:0.1}
```

**No-op without DSN is a requirement.** With `SENTRY_DSN` unset the placeholder resolves to an empty string and
the SDK stays disabled: no network access at startup, no events. This holds during build-time steps without
network, for example a Docker build stage that runs with `--network=none` and starts the Spring context (a CDS
training run). Never add a default DSN value and never make a bean call Sentry at startup.

## 3. Masking

`SensitiveDataMasker.java`: a pure class, so it can be unit tested without Spring. The five rules run **in this
order**, and the order matters (a JWT inside a `Bearer` header becomes `Bearer [jwt]`; an IBAN is masked before
the card-like rule can see its digits).

The card-like rule also masks other long digit runs, such as numeric ids and epoch-millisecond timestamps. That is
on purpose (privacy over readability): do not narrow it.

```java
package <base-package>.observability;

import java.util.List;
import java.util.regex.Pattern;

/**
 * Masks personal data in free text before it leaves the application for Sentry.
 * The rules run in a fixed order: an earlier rule can change what a later one sees.
 */
public final class SensitiveDataMasker {

    private record Rule(Pattern pattern, String replacement) {}

    private static final List<Rule> RULES = List.of(
            new Rule(Pattern.compile("eyJ[\\w-]+\\.[\\w-]+\\.[\\w-]+"), "[jwt]"),
            new Rule(Pattern.compile("Bearer\\s+[A-Za-z0-9._~+/=-]+"), "Bearer [token]"),
            new Rule(Pattern.compile("[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}"), "[email]"),
            new Rule(Pattern.compile("\\b[A-Z]{2}\\d{2}(?:\\s?[A-Z0-9]{4}){2,7}(?:\\s?[A-Z0-9]{1,4})?\\b"), "[iban]"),
            new Rule(Pattern.compile("\\b(?:\\d[ -]?){12,18}\\d\\b"), "[number]"));

    private SensitiveDataMasker() {}

    public static String mask(String text) {
        if (text == null || text.isEmpty()) {
            return text;
        }
        String result = text;
        for (Rule rule : RULES) {
            result = rule.pattern().matcher(result).replaceAll(rule.replacement());
        }
        return result;
    }
}
```

`SentryMaskingConfig.java`: the Sentry starter picks up `SentryOptions.BeforeSendCallback` and
`SentryOptions.BeforeBreadcrumbCallback` beans automatically. The first masks the event message (raw, formatted and
its parameters), exception values, the string values of the event `extra` map, and each breadcrumb's message and
string `data` values; the second masks breadcrumbs the same way as they are recorded.

```java
package <base-package>.observability;

import io.sentry.Breadcrumb;
import io.sentry.Hint;
import io.sentry.SentryEvent;
import io.sentry.SentryOptions;
import io.sentry.protocol.Message;
import io.sentry.protocol.SentryException;
import java.util.List;
import java.util.Map;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

/** Registers the callbacks the Sentry starter picks up to mask personal data. */
@Configuration
public class SentryMaskingConfig {

    @Bean
    public SentryOptions.BeforeSendCallback sentryBeforeSend() {
        return (SentryEvent event, Hint hint) -> {
            Message message = event.getMessage();
            if (message != null) {
                message.setMessage(SensitiveDataMasker.mask(message.getMessage()));
                message.setFormatted(SensitiveDataMasker.mask(message.getFormatted()));
                List<String> params = message.getParams();
                if (params != null) {
                    message.setParams(params.stream().map(SensitiveDataMasker::mask).toList());
                }
            }
            if (event.getExceptions() != null) {
                for (SentryException exception : event.getExceptions()) {
                    exception.setValue(SensitiveDataMasker.mask(exception.getValue()));
                }
            }
            maskStringValues(event.getExtras());
            if (event.getBreadcrumbs() != null) {
                for (Breadcrumb breadcrumb : event.getBreadcrumbs()) {
                    maskBreadcrumb(breadcrumb);
                }
            }
            return event;
        };
    }

    @Bean
    public SentryOptions.BeforeBreadcrumbCallback sentryBeforeBreadcrumb() {
        return (Breadcrumb breadcrumb, Hint hint) -> {
            maskBreadcrumb(breadcrumb);
            return breadcrumb;
        };
    }

    private static void maskBreadcrumb(Breadcrumb breadcrumb) {
        breadcrumb.setMessage(SensitiveDataMasker.mask(breadcrumb.getMessage()));
        maskStringValues(breadcrumb.getData());
    }

    /** Masks the String values of a map in place; other values are left as they are. */
    private static void maskStringValues(Map<String, Object> values) {
        if (values != null) {
            values.replaceAll((key, value) -> value instanceof String text ? SensitiveDataMasker.mask(text) : value);
        }
    }
}
```

If the project already defines its own `BeforeSendCallback` bean, do not add a second one: call
`SensitiveDataMasker` from the existing callback instead and show the user the change.

## 4. Tests (JUnit 5)

Put them under `src/test/java/<base-package path>/observability/`. Adapt to the project's existing test style
(assertion library, naming) when it differs. The `SentryMaskingConfigTest` is a `@SpringBootTest`; if the project
tests need a database or other infrastructure for a full context, use a plain unit test that builds
`new SentryMaskingConfig().sentryBeforeSend()` (and `sentryBeforeBreadcrumb()`) instead and keep the disabled-SDK assertion only where the context
can start.

`SensitiveDataMaskerTest.java`:

```java
package <base-package>.observability;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;

import org.junit.jupiter.api.Test;

class SensitiveDataMaskerTest {

    private static final String JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.c2lnbmF0dXJl";

    @Test
    void masksJwt() {
        assertEquals("token=[jwt] end", SensitiveDataMasker.mask("token=" + JWT + " end"));
    }

    @Test
    void masksBearerToken() {
        assertEquals("Authorization: Bearer [token]",
                SensitiveDataMasker.mask("Authorization: Bearer abc123.def-456_ghi"));
    }

    @Test
    void jwtInsideBearerHeaderIsMaskedByTheJwtRuleFirst() {
        // Order matters: the JWT rule runs first, and "[jwt]" does not match the Bearer rule afterwards.
        assertEquals("Authorization: Bearer [jwt]", SensitiveDataMasker.mask("Authorization: Bearer " + JWT));
    }

    @Test
    void masksEmail() {
        assertEquals("user [email] failed", SensitiveDataMasker.mask("user jane.doe+tag@example.co.uk failed"));
    }

    @Test
    void masksIbanWithAndWithoutSpaces() {
        assertEquals("to [iban]", SensitiveDataMasker.mask("to ES9121000418450200051332"));
        assertEquals("to [iban]", SensitiveDataMasker.mask("to DE89 3704 0044 0532 0130 00"));
    }

    @Test
    void ibanRuleRunsBeforeCardRule() {
        // The spaced digit groups of this IBAN also match the card rule: in the wrong order the result
        // would be "DE89 [number]".
        assertEquals("[iban]", SensitiveDataMasker.mask("DE89 3704 0044 0532 0130 00"));
    }

    @Test
    void masksCardLikeNumbers() {
        assertEquals("card [number]", SensitiveDataMasker.mask("card 4111 1111 1111 1111"));
        assertEquals("card [number]", SensitiveDataMasker.mask("card 4111-1111-1111-1111"));
        assertEquals("card [number]", SensitiveDataMasker.mask("card 4111111111111111"));
    }

    @Test
    void leavesShortNumbersAndPlainTextAlone() {
        assertEquals("order 12345 in 2026", SensitiveDataMasker.mask("order 12345 in 2026"));
    }

    @Test
    void handlesNullAndEmpty() {
        assertNull(SensitiveDataMasker.mask(null));
        assertEquals("", SensitiveDataMasker.mask(""));
    }
}
```

`SentryMaskingConfigTest.java` (checks the wiring and that an empty DSN leaves the SDK disabled; the explicit
`sentry.dsn=` keeps it deterministic even if `SENTRY_DSN` is set on the machine):

```java
package <base-package>.observability;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;

import io.sentry.Breadcrumb;
import io.sentry.Hint;
import io.sentry.Sentry;
import io.sentry.SentryEvent;
import io.sentry.SentryOptions;
import io.sentry.protocol.Message;
import io.sentry.protocol.SentryException;
import java.util.List;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;

@SpringBootTest(properties = "sentry.dsn=")
class SentryMaskingConfigTest {

    @Autowired
    SentryOptions.BeforeSendCallback beforeSend;

    @Autowired
    SentryOptions.BeforeBreadcrumbCallback beforeBreadcrumb;

    @Test
    void sdkIsDisabledWithEmptyDsn() {
        assertFalse(Sentry.isEnabled());
    }

    @Test
    void beforeSendMasksMessageExceptionsAndBreadcrumbs() {
        SentryEvent event = new SentryEvent();
        Message message = new Message();
        message.setMessage("login failed for jane@example.com");
        event.setMessage(message);

        SentryException exception = new SentryException();
        exception.setValue("bad iban ES9121000418450200051332");
        event.setExceptions(List.of(exception));

        Breadcrumb breadcrumb = new Breadcrumb();
        breadcrumb.setMessage("card 4111 1111 1111 1111");
        event.addBreadcrumb(breadcrumb);

        SentryEvent result = beforeSend.execute(event, new Hint());

        assertEquals("login failed for [email]", result.getMessage().getMessage());
        assertEquals("bad iban [iban]", result.getExceptions().get(0).getValue());
        assertEquals("card [number]", result.getBreadcrumbs().get(0).getMessage());
    }

    @Test
    void beforeSendMasksMessageParamsExtrasAndBreadcrumbData() {
        SentryEvent event = new SentryEvent();
        Message message = new Message();
        message.setMessage("login failed for {}");
        message.setFormatted("login failed for jane@example.com");
        message.setParams(List.of("jane@example.com"));
        event.setMessage(message);
        event.setExtra("account", "DE89 3704 0044 0532 0130 00");
        event.setExtra("attempts", 3);

        Breadcrumb breadcrumb = new Breadcrumb();
        breadcrumb.setData("url", "/users?email=jane@example.com");
        event.addBreadcrumb(breadcrumb);

        SentryEvent result = beforeSend.execute(event, new Hint());

        assertEquals("login failed for [email]", result.getMessage().getFormatted());
        assertEquals(List.of("[email]"), result.getMessage().getParams());
        assertEquals("[iban]", result.getExtra("account"));
        assertEquals(3, result.getExtra("attempts"));
        assertEquals("/users?email=[email]", result.getBreadcrumbs().get(0).getData("url"));
    }

    @Test
    void beforeBreadcrumbMasksMessageAndData() {
        Breadcrumb breadcrumb = new Breadcrumb();
        breadcrumb.setMessage("Authorization: Bearer abc123");
        breadcrumb.setData("to", "jane@example.com");

        Breadcrumb result = beforeBreadcrumb.execute(breadcrumb, new Hint());

        assertEquals("Authorization: Bearer [token]", result.getMessage());
        assertEquals("[email]", result.getData("to"));
    }
}
```

## 5. Release wiring (Dockerfile)

Only if the project has a `Dockerfile`. In the **runtime** stage (the last `FROM`), add the build argument and
turn it into the environment variable the property reads. Do not add it to earlier stages, and do not give it a
default, so a local `docker build` without the argument still works and the release stays empty:

```dockerfile
ARG SENTRY_RELEASE
ENV SENTRY_RELEASE=${SENTRY_RELEASE}
```

If the Dockerfile runs a training/CDS step with `RUN --network=none`, place these two lines **after** it or
leave them: an empty release and an empty DSN keep the SDK off either way.

GitHub Actions (only if a workflow already builds the image): pass the commit SHA in the build step, for example
with `docker/build-push-action`:

```yaml
build-args: |
  SENTRY_RELEASE=${{ github.sha }}
```

or `docker build --build-arg SENTRY_RELEASE=${{ github.sha }} .`. Add the line to the existing step and show it to
the user; do not create a workflow.

## 6. `.env.example` names

`SENTRY_DSN=`, `SENTRY_ENVIRONMENT=`, `SENTRY_RELEASE=`, `SENTRY_TRACES_SAMPLE_RATE=`. Names only, no values.
