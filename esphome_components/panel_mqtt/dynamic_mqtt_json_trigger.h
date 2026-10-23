#pragma once

#include <string>
#include <utility>

#include "dynamic_topic_alias.h"
#include "esphome/components/mqtt/mqtt_client.h"
#include "esphome/core/component.h"
#include "esphome/core/automation.h"

namespace esphome::panel_mqtt {

class DynamicMqttJsonMessageTrigger : public Trigger<JsonObjectConst>, public Component {
 public:
  DynamicMqttJsonMessageTrigger(std::string topic_suffix, uint8_t qos)
      : topic_suffix_(std::move(topic_suffix)), qos_(qos) {}

  void setup() override {
    this->mqtt_client_ = mqtt::global_mqtt_client;
    this->subscribe_to_prefix_(this->mqtt_client_->get_topic_prefix());
    DynamicTopicAliasRegistry::register_subscription(
        [this](const std::string &prefix) { this->subscribe_to_prefix_(prefix); },
        [this](const std::string &prefix) { this->unsubscribe_from_prefix_(prefix); });
  }

  float get_setup_priority() const override { return setup_priority::AFTER_CONNECTION; }

 protected:
  void subscribe_to_prefix_(const std::string &prefix) {
    const std::string topic = prefix + "/" + this->topic_suffix_;
    this->mqtt_client_->subscribe_json(topic, [this](const std::string &, JsonObject root) { this->trigger(root); }, this->qos_);
  }

  void unsubscribe_from_prefix_(const std::string &prefix) {
    this->mqtt_client_->unsubscribe(prefix + "/" + this->topic_suffix_);
  }

  mqtt::MQTTClientComponent *mqtt_client_{nullptr};
  std::string topic_suffix_;
  uint8_t qos_{0};
};

class DynamicMqttMessageTrigger : public Trigger<std::string>, public Component {
 public:
  DynamicMqttMessageTrigger(std::string topic_suffix, uint8_t qos)
      : topic_suffix_(std::move(topic_suffix)), qos_(qos) {}

  void setup() override {
    this->mqtt_client_ = mqtt::global_mqtt_client;
    this->subscribe_to_prefix_(this->mqtt_client_->get_topic_prefix());
    DynamicTopicAliasRegistry::register_subscription(
        [this](const std::string &prefix) { this->subscribe_to_prefix_(prefix); },
        [this](const std::string &prefix) { this->unsubscribe_from_prefix_(prefix); });
  }

  float get_setup_priority() const override { return setup_priority::AFTER_CONNECTION; }

 protected:
  void subscribe_to_prefix_(const std::string &prefix) {
    const std::string topic = prefix + "/" + this->topic_suffix_;
    this->mqtt_client_->subscribe(topic, [this](const std::string &, const std::string &payload) { this->trigger(payload); }, this->qos_);
  }

  void unsubscribe_from_prefix_(const std::string &prefix) {
    this->mqtt_client_->unsubscribe(prefix + "/" + this->topic_suffix_);
  }

  mqtt::MQTTClientComponent *mqtt_client_{nullptr};
  std::string topic_suffix_;
  uint8_t qos_{0};
};

}  // namespace esphome::panel_mqtt
