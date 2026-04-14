# Shuffle Orborus 
A general job runner with two modes:

1. Sensor: endpoint monitoring and response. Optional live-debugging (`--response_actions=full`)
2. Container orchestrator: manages automation and scale. Primarily used for Shuffle Workflows.


## Monitor & Respond
<img width="1044" height="326" alt="Sensor Monitor list" src="https://github.com/user-attachments/assets/128f4ee0-06d0-4632-83b8-589bea6c230f" />

<img width="1149" height="838" alt="Optional Sensor RCE" src="https://github.com/user-attachments/assets/267c2df9-fbb0-4654-aded-8cb9f31e67a4" />


```
```

## Container Orchestrator mode
This is primarily used for running Workflows in Shuffle. Works with Docker and Kubernetes.
```
docker run -d \
	--restart=always \
	--name="shuffle-orborus" \
	--pull=always \
	--volume "/var/run/docker.sock:/var/run/docker.sock" \
	-e ENVIRONMENT_NAME="queue name" \ 	  # Runtime location name
	-e AUTH="auth" \					  # Auth for the runtime location 
	-e ORG="org" \ 						  # Your Shuffle org
	-e SHUFFLE_SWARM_CONFIG=run \ 		  
	-e BASE_URL="http://localhost:5002" \ # Your backend
	ghcr.io/shuffle/shuffle-orborus:latest
```

# How it works
If you want to use it for your project, you can 

1. Orborus polls for jobs from ${BASE_URL}/api/v1/queue
2. Jobs are returned in the format

## Testing
Development branch: 
```
git checkout nightly
```

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
