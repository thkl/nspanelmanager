#pragma once

#include <cctype>
#include <cstdio>
#include <string>

#include "dynamic_topic_alias.h"
#include "esphome/components/mqtt/mqtt_client.h"
#include "esphome/core/component.h"
#include "esphome/core/helpers.h"

namespace esphome::panel_mqtt {

/** Tracks the panel's bootstrap and operational MQTT roots for runtime topic switching. */
class PanelMqttComponent : public Component {
 public:
  /** Captures the MAC-based MQTT prefix selected before the broker connection. */
  void setup() override {
    this->mqtt_client_ = mqtt::global_mqtt_client;
    if (this->mqtt_client_ == nullptr) {
      this->mark_failed();
      return;
    }
    this->bootstrap_topic_prefix_ = this->mqtt_client_->get_topic_prefix();
    this->active_topic_prefix_ = this->bootstrap_topic_prefix_;
    if (!this->initial_topic_prefix_.empty() && this->is_valid_topic_prefix_(this->initial_topic_prefix_) &&
        this->initial_topic_prefix_ != this->bootstrap_topic_prefix_) {
      this->active_topic_prefix_ = this->initial_topic_prefix_;
      DynamicTopicAliasRegistry::set_alias(this->initial_topic_prefix_);
    }
  }

  float get_setup_priority() const override { return setup_priority::AFTER_CONNECTION; }

  /** Switches outgoing topics immediately and schedules subscriptions to rebind on the main loop. */
  bool set_active_topic_prefix(const std::string &topic_prefix) {
    if (!this->is_valid_topic_prefix_(topic_prefix)) return false;
    if (this->mqtt_client_ == nullptr) return false;

    this->active_topic_prefix_ = topic_prefix;
    const std::string alias = topic_prefix == this->bootstrap_topic_prefix_ ? "" : topic_prefix;
    this->defer("panel_mqtt_alias", [alias]() { DynamicTopicAliasRegistry::set_alias(alias); });
    return true;
  }

  /** Selects the persisted operational prefix before MQTT subscriptions are registered. */
  void set_initial_topic_prefix(const std::string &topic_prefix) {
    if (!this->is_valid_topic_prefix_(topic_prefix)) return;
    this->initial_topic_prefix_ = topic_prefix;
    if (this->mqtt_client_ != nullptr) this->set_active_topic_prefix(topic_prefix);
  }

  /** Returns the topic prefix currently used for panel commands and events. */
  const std::string &get_active_topic_prefix() const { return this->active_topic_prefix_; }

  /** Returns the stable MAC-based prefix used for identity and settings messages. */
  const std::string &get_bootstrap_topic_prefix() const { return this->bootstrap_topic_prefix_; }
  /** Returns whether the manager has supplied the normal operational node name. */
  bool has_active_alias() const {
    return !this->active_topic_prefix_.empty() && this->active_topic_prefix_ != this->bootstrap_topic_prefix_;
  }

  /** Returns the chip's MAC address as twelve lowercase hexadecimal characters. */
  std::string get_mac_address() const {
    uint8_t mac_bytes[6]{};
    esphome::get_mac_address_raw(mac_bytes);
    char mac_address[13]{};
    for (size_t index = 0; index < 6; index++) {
      std::snprintf(mac_address + index * 2, 3, "%02x", mac_bytes[index]);
    }
    return mac_address;
  }

 protected:
  bool is_valid_topic_prefix_(const std::string &topic_prefix) const {
    if (topic_prefix.empty()) return false;
    for (const unsigned char character : topic_prefix) {
      if (!(std::isalnum(character) || character == '_' || character == '-')) return false;
    }
    return true;
  }

  mqtt::MQTTClientComponent *mqtt_client_{nullptr};
  std::string bootstrap_topic_prefix_;
  std::string active_topic_prefix_;
  std::string initial_topic_prefix_;
};

}  // namespace esphome::panel_mqtt
