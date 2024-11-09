#!/bin/bash

# Define the log file
log_file="mon.sh.log"
backup_log_file="$HOME/script/token-server.log.bak"

while(true)
do

        # Check the size of the log file
        if [ -e "$log_file" ] && [ $(du -m "$log_file" | cut -f1) -ge 100 ]
        then
            # If the log file is larger than 100 MB, copy it to the backup file and purge the log file
            cp "$log_file" "$backup_log_file"
            echo "" > "$log_file"
        fi

        # Check token-server.js is running
        counter=`ps -ef | grep -v grep | grep -c "token-server.js"`
        if [ $counter -eq 0 ]
        then
            # If the application is not running, start it
            echo "Counter is $counter"
            echo "$(date '+%Y%m%d %H:%M:%S') - token-server.js is not running. Starting it..." >> $log_file
            /usr/bin/node token-server.js >> $log_file 2>&1 &

        else
            # If the application is running, log it
            echo "$(date '+%Y%m%d %H:%M:%S') - token-server.js is running smoothly" >> $log_file
        fi

        # Check proxy-server.js is running
        counter1=`ps -ef | grep -v grep | grep -v sso-proxy-server.js | grep -c "proxy-server.js"`
        if [ $counter1 -eq 0 ]
        then
            # If the application is not running, start it
            echo "Counter is $counter1"
            echo "$(date '+%Y%m%d %H:%M:%S') - proxy-server.js is not running. Starting it..." >> $log_file
            /usr/bin/node proxy-server.js >> $log_file 2>&1 &

        else
            # If the application is running, log it
            echo "$(date '+%Y%m%d %H:%M:%S') - proxy-server.js is running smoothly" >> $log_file
        fi

        # Check sso-server.js is running
        counter2=`ps -ef | grep -v grep | grep -c "sso-server.js"`
        if [ $counter2 -eq 0 ]
        then
            # If the application is not running, start it
            echo "Counter is $counter2"
            echo "$(date '+%Y%m%d %H:%M:%S') - sso-server.js is not running. Starting it..." >> $log_file
            /usr/bin/node sso-server.js >> $log_file 2>&1 &

        else
            # If the application is running, log it
            echo "$(date '+%Y%m%d %H:%M:%S') - sso-server.js is running smoothly" >> $log_file
        fi

        # Check sso-proxy-server.js is running
        counter3=`ps -ef | grep -v grep | grep -c "sso-proxy-server.js"`
        if [ $counter3 -eq 0 ]
        then
            # If the application is not running, start it
            echo "Counter is $counter3"
            echo "$(date '+%Y%m%d %H:%M:%S') - sso-proxy-server.js is not running. Starting it..." >> $log_file
            /usr/bin/node sso-proxy-server.js >> $log_file 2>&1 &

        else
            # If the application is running, log it
            echo "$(date '+%Y%m%d %H:%M:%S') - sso-proxy-server.js is running smoothly" >> $log_file
        fi

        # Check if Redis is running
        redis_counter=`ps -ef | grep -v grep | grep -c redis-server`
        if [ $redis_counter -eq 0 ]
        then
            # If Redis is not running, start it
            echo "Redis counter is $redis_counter"
            echo "$(date '+%Y%m%d %H:%M:%S') - Redis server is not running. Starting it..." >> $log_file
            systemctl start redis >> $log_file 2>&1 &

        else
            # If Redis is running, log it
            echo "$(date '+%Y%m%d %H:%M:%S') - Redis server is running smoothly" >> $log_file
        fi

        sleep 30

        echo " " >> $log_file
done
