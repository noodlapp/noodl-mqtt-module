"use strict";
const Noodl = require('@noodl/noodl-sdk');
const MQTTConnection = require('./mqttconnection');

function extractKeysFromJSON(obj, result, parentPath) {
    for(var i in obj) {
      var path = parentPath + i;
      if(typeof obj[i] == "object" && obj[i] !== null && !Array.isArray(obj[i])){
        extractKeysFromJSON(obj[i], result, path + '.');
      }
      else {
        result.push({key: path, value: obj[i]});
      }
    }
}

const ReceiveMessageNode  = Noodl.defineNode({
    name: "Receive Message",
    category: "MQTT",
    useInputAsLabel: "topic",
    color: "purple",
    initialize: function() {
        this.payload = {};
        this.messageReceived = false;
        this.inputs.enabled = true;
        this.inputs.topic = '';
        this.topicValues = {};
        this.topicOutputs = {};
        this.payloadValues = {};
    },
    inputs: {
        enabled: {
            displayName: 'Enabled',
            type: 'boolean',
            default: true
        },
        topic: {
            displayName:'Topic',
            type:'string',
            default:'',
        },
        payload: {
            type:{name:'stringlist',allowEditOnly:true},
            group:'Payload',
        }
    },
    changed: {
        topic:function() {
            this.scheduleSubscribe();
        }
    },
    outputs: {
        messageReceived: {
            displayName: 'Received',
            type: 'signal'
        }
    },
    methods: {
      onNodeDeleted: function() {
        if (this.subscription) {
          MQTTConnection.instance.unsubscribe(this.subscription.topic, this.subscription.subscriber);
          this.subscription = undefined;
        }
      },
      registerInputIfNeeded: function (name) {
        if (this.hasInput(name)) {
          return;
        }

        this.registerInput(name, {
          set: this.setTopicValue.bind(this, name.substring('topic-'.length))
        });
      },
      registerOutputIfNeeded: function (name) {
        if (this.hasOutput(name)) {
          return;
        }

        if(name.startsWith('topic-')) this.registerOutput(name, {
          getter: this.getTopicValue.bind(this, name.substring('topic-'.length))
        })

        if(name.startsWith('payload-')) this.registerOutput(name, {
            getter: this.getPayloadValue.bind(this, name.substring('payload-'.length))
        })
      },
      setTopicValue:function(name,value) {
        this.topicValues[name] = value;
        this.scheduleSubscribe();
      },
      getTopicValue:function(name) {
        return this.topicOutputs[name];
      },
      getPayloadValue:function(name) {
        return this.payloadValues[name];
      },
      computeTopic:function() {
        var topic = this.inputs.topic;
        var components = this.topicValues;
        for(var i in components) {
            topic = topic.replace('{' + i + '}',components[i]);
        }

        // Return and replace all +filters+ with just +
        return topic.replace(/\+([a-z]|[A-Z])([a-z]|[A-Z]|[0-9])*\+/g,'+');
      },
      handleMessage: function(message) {
        if(this.inputs.enabled === false) {
            return;
        }

        // Extract topic components
        var filterComponents = this.inputs.topic.split('/');
        var topicComponents = message.topic.split('/');
        for(var i = 0; i < topicComponents.length; i++) {
          var c = filterComponents[i];
          if(c.length >= 3 && c[0] === '+' && c[c.length-1] === '+') {
            var name = c.substring(1,c.length-1);
            this.topicOutputs[name] = topicComponents[i];
            this.flagOutputDirty('topic-'+name);
          }
        }

        // Extract payload and send signal
        var result = [];
        var payload = message.payload;
        if(typeof payload === 'object') {
          extractKeysFromJSON(payload, result, '')
        }
        else { // We assume that the payload is in CSV
          var outputPortList = []
          if(this.inputs.payload) outputPortList = this.inputs.payload.split(',');

          payload.split(',').forEach(function(value, i) {
            result.push({key: outputPortList[i], value: value});
          })
        }

        for(var i=0; i<result.length; i++) {
          var r = result[i];
          this.payloadValues[r.key] = r.value;
          if(this.hasOutput('payload-'+r.key)) {
            this.flagOutputDirty('payload-'+r.key);
          }
        }

        this.sendSignalOnOutput("messageReceived");
       // this.context.scheduleUpdate(); ???
      },
      scheduleSubscribe:function() {
        if(this.subscribeScheduled) return;
        this.subscribeScheduled = true;

        this.scheduleAfterInputsHaveUpdated(() => {
            this.subscribeScheduled = false;
            this.subscribe();
        });
      },
      subscribe: function () {
        // Remove old subscription if any
        if (this.subscription) {
          MQTTConnection.instance.unsubscribe(this.subscription.topic, this.subscription.subscriber);
            this.subscription = undefined;
        }

        // Compute new topic and subscribe to it
        var topic = this.computeTopic();
        if(!topic) return;

        var subscriber = this.handleMessage.bind(this);
        this.subscription = {topic:topic,
                                subscriber:subscriber};
        MQTTConnection.instance.subscribe(topic,subscriber);
     /*   this.context.eventEmitter.once("applicationDataReloaded", function() {
          Services.pubsub.unsubscribe(topic,subscriber);
        }); ????*/
       }
     },
     setup: function(context, graphModel) {

        if(!context.editorConnection || !context.editorConnection.isRunningLocally()) {
            return;
        }

        graphModel.on("nodeAdded.Receive Message", function(node) {
            function updatePorts() {
                var ports = [];

                const topic = node.parameters.topic;
                if(topic) {
                    var inputs = topic.match(/\{([a-z]|[A-Z])([a-z]|[A-Z]|[0-9])*\}/g);
                
                    for(var i in inputs) {
                        var p = inputs[i].replace(/(\{|\})/g,'');
                        ports.push({name:'topic-'+p,
                            displayName:p,
                            group:'Topic components',
                            plug:'input',
                            type:'*'});
                    }

                
                    var outputs = topic.match(/\+([a-z]|[A-Z])([a-z]|[A-Z]|[0-9])*\+/g);
                
                    for(var i in outputs) {
                        var p = outputs[i].replace(/(\+|\+)/g,'');
                        ports.push({name:'topic-'+p,
                                    displayName:p,
                                    group:'Topic components',
                                    plug:'output',
                                    type:'*'});
                    }
                }

                const payload = node.parameters.payload;
                if(payload) {
                    payload.split(',').forEach((p) => {
                        ports.push({
                            name: 'payload-'+p, // The name of the port, we add a prefix to know that this port is a payload port
                            displayName:p,
                            group: 'Payload',
                            plug: 'output',
                            type: {name:'*',allowConnectionsOnly:true}
                        });
                    })
                }
            
                context.editorConnection.sendDynamicPorts(node.id,ports);
            }

            if(node.parameters.topic || node.parameters.payload) {
                updatePorts();
            }
            node.on("parameterUpdated", function(event) {
                if(event.name === "topic" || event.name === "payload") {
                    updatePorts();
                }
            });
        });
    }
})

module.exports = ReceiveMessageNode;