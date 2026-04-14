# Shuffle Orborus 
A general job runner for endpoint monitoring and response, as well as container orchestration

## Monitor & Respond
```
```

## Container Orchestrator mode
This is primarily used for running Workflows in Shuffle. 
```
docker run -d \
	--restart=always \
	--name="shuffle-orborus" \
	--pull=always \
	--volume "/var/run/docker.sock:/var/run/docker.sock" \
	-e ENVIRONMENT_NAME="queue name" \
	-e AUTH="auth" \
	-e ORG="org" \
	-e SHUFFLE_SWARM_CONFIG=run \
	-e BASE_URL="http://localhost:5002" \
	ghcr.io/shuffle/shuffle-orborus:latest
```

# How it works
If you want to use it for your project, you can 

1. Orborus polls for jobs from ${BASE_URL}/api/v1/queue
2. Jobs are returned in the format

## Testing
**Monitor and Respond**
```
go run orborus.go --sensor_mode=true
```

**Container Orchestration**
```
go run orborus.go <flags>
```


## Control flags
**Monitor and respond**
```
--queue=Runtime Location
--auth=auth 
--org_id=orgid 
--software_list_enabled=true 
--hd_encrypted_check=true 
--screenlock_check=true
--response_actions=full
```
