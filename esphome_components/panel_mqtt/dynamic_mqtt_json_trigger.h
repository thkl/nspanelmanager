#pragma once

#include <string>
#include <utility>

#include "esphome/components/mqtt/mqtt_client.h"
#include "esphome/core/component.h"
#include "esphome/core/automation.h"

namespace esphome::panel_mqtt {

class DynamicMqttJsonMessageTrigger : public Trigger<JsonObjectConst>, public Component {
 public:
  DynamicMqttJsonMessageTrigger(std::string topic_suffix, uint8_t qos)
      : topic_suffix_(std::move(topic_suffix)), qos_(qos) {}

  void setup() override {
    const std::string topic = mqtt::global_mqtt_client->get_topic_prefix() + "/" + this->topic_suffix_;
    mqtt::global_mqtt_client->subscribe_json(topic, [this](const std::string &, JsonObject root) { this->trigger(root); },
                                             this->qos_);
  }

  float get_setup_priority() const override { return setup_priority::AFTER_CONNECTION; }

 protected:
  std::string topic_suffix_;
  uint8_t qos_{0};
};

class DynamicMqttMessageTrigger : public Trigger<std::string>, public Component {
 public:
  DynamicMqttMessageTrigger(std::string topic_suffix, uint8_t qos)
      : topic_suffix_(std::move(topic_suffix)), qos_(qos) {}

  void setup() override {
    const std::string topic = mqtt::global_mqtt_client->get_topic_prefix() + "/" + this->topic_suffix_;
    mqtt::global_mqtt_client->subscribe(topic, [this](const std::string &, const std::string &payload) { this->trigger(payload); },
                                        this->qos_);
  }

  float get_setup_priority() const override { return setup_priority::AFTER_CONNECTION; }

 protected:
  std::string topic_suffix_;
  uint8_t qos_{0};
};

}  // namespace esphome::panel_mqtt
