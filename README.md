# Shuffle Orborus 
A general job runner with two modes:

1. Sensor: endpoint monitoring and response. Optional live-debugging (`--response_actions=full`)
2. Container orchestrator: manages automation and scale. Primarily used for Shuffle Workflows.


## 1. Monitor & Respond
Retrieves the relevant data you want from a host based on enabled features. 

If ran in Shuffle, sensors require a Sensor Group. This is a Runtime Location with the "sensor_group: true" flag. 

<img width="618" height="837" alt="Creating a new host in a sensor group" src="https://github.com/user-attachments/assets/d750ee72-1403-4c41-b7a0-99cbadb4501d" />
<img width="1044" height="326" alt="Sensor Monitor list" src="https://github.com/user-attachments/assets/128f4ee0-06d0-4632-83b8-589bea6c230f" />
<img width="1149" height="838" alt="Optional Sensor RCE" src="https://github.com/user-attachments/assets/267c2df9-fbb0-4654-aded-8cb9f31e67a4" />


```
```

## 2. Container Orchestrator mode
This is primarily used for running Workflows in Shuffle. Works with Docker and Kubernetes.

<img width="1185" height="580" alt="image" src="https://github.com/user-attachments/assets/55eee895-9f91-4245-90b2-70d02e5c36b2" />


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

## How it works (monitoring sensor)
1. Polls for tasks every 2-60 seconds, while sending details back realtime: `POST /api/v1/streams -H "Org-Id: queuename" -H "Org: orgid" -H "Authorization: auth" -d '{"id": "queuename"}'`. The headers are used for authentication. The full available data struct is [OrborusStats{} here](https://github.com/Shuffle/shuffle-shared/blob/main/structs.go#L4274).
2. Performs the tasks and sends the result back to the correct area (usually workflow execution)
3. Repeat
