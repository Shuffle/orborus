FROM --platform=$BUILDPLATFORM golang:1.25 AS builder
ARG TARGETOS TARGETARCH

WORKDIR /app

COPY go.mod go.sum ./
RUN go mod download

COPY . .
RUN CGO_ENABLED=0 GOOS=${TARGETOS} GOARCH=${TARGETARCH} go build -o /app/orborus .

FROM alpine:3.22.1

RUN apk add --no-cache bash tzdata
COPY --from=builder /app/orborus /orborus
ENV ENVIRONMENT_NAME=Shuffle \
    BASE_URL=http://shuffle-backend:5001 \
    DOCKER_API_VERSION=1.44 \
    SHUFFLE_OPENSEARCH_URL=https://opensearch:9200

CMD ["./orborus"]
