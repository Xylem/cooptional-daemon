FROM node:6.9.2

RUN echo deb http://ftp.debian.org/debian jessie-backports main >> /etc/apt/sources.list && \
    apt-get update && \
    apt-get install -y libgd2-dev && \
    apt-get -t jessie-backports install -y ffmpeg && \
    git clone https://github.com/tmbdev/ocropy.git && \
    cd ocropy && \
    apt-get install -y $(cat PACKAGES) && \
    python setup.py install && \
    apt-get clean

RUN mkdir -p /usr/src/app && mkdir /usr/src/app/tmp
WORKDIR /usr/src/app

COPY package.json /usr/src/app/
RUN npm install
COPY src /usr/src/app/src

CMD [ "npm", "start" ]
