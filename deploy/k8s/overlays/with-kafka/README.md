# Overlay: app + Kafka KRaft no namespace `genesis`.
#
#   # NÃO aplicar Contabo sem runbook — só quando houver cluster:
#   kubectl apply -k deploy/k8s/overlays/with-kafka/
#
# Patch: KAFKA_ENABLED=1 + brokers internos.
# Base: deploy/k8s/ (+ kafka StatefulSet / topics job).
