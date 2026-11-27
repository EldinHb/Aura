# kotlinx.serialization keeps its generated serializers through its own
# consumer rules; the protocol classes are only reached through them.
-keepattributes *Annotation*, InnerClasses
-dontnote kotlinx.serialization.**

# OkHttp's optional platform integrations.
-dontwarn org.bouncycastle.**
-dontwarn org.conscrypt.**
-dontwarn org.openjsse.**
